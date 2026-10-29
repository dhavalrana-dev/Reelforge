import type { Project } from "@reelforge/core";
import { activeScenes, pageHtml, renderFrameHtml, validateComposition } from "@reelforge/motion";
import type { Browser, CDPSession, Page } from "playwright-core";
import { launchBrowser } from "./browser";

export interface FrameRendererOptions {
  /**
   * Pages painting in parallel. Each gets its own browser process, which
   * scales far better than several pages in one browser (they share one
   * capture pipeline).
   */
  concurrency?: number;
  /** Paint every page in this browser instead of launching our own (faster startup, less parallelism). */
  browser?: Browser;
}

export interface RenderStats {
  painted: number;
  reused: number;
  empty: number;
}

/** How many recent frames' markup → PNG results are kept for reuse (static holds). */
const REUSE_CACHE = 16;

/**
 * Paints composition frames as transparent PNGs. The browser only lays out
 * and rasterises; all animation state is computed in Node from the frame
 * number, so frames can be painted in any order with identical results.
 */
export class FrameRenderer {
  readonly stats: RenderStats = { painted: 0, reused: 0, empty: 0 };
  private chains: Promise<unknown>[];
  private cache = new Map<string, Promise<Buffer>>();
  private emptyFrame?: Promise<Buffer>;

  private constructor(
    private readonly project: Project,
    /** Browsers we launched and must close. */
    private readonly ownedBrowsers: Browser[],
    private readonly pages: { page: Page; cdp: CDPSession }[],
  ) {
    this.chains = pages.map(() => Promise.resolve());
  }

  static async create(project: Project, { concurrency = 4, browser }: FrameRendererOptions = {}): Promise<FrameRenderer> {
    const errors = validateComposition(project);
    if (errors.length) throw new Error(`invalid composition:\n  ${errors.join("\n  ")}`);

    const n = Math.max(1, concurrency);
    const owned = browser ? [] : await Promise.all(Array.from({ length: n }, () => launchBrowser()));
    const { width, height } = project.project;
    const html = pageHtml(project);
    const pages = await Promise.all(
      Array.from({ length: n }, async (_, i) => {
        const page = await (browser ?? owned[i]!).newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
        await page.setContent(html);
        await page.evaluate(() => document.fonts.ready);
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
        return { page, cdp };
      }),
    );
    return new FrameRenderer(project, owned, pages);
  }

  /** Paints one frame. */
  renderFrame(frame: number): Promise<Buffer> {
    return this.schedule(frame);
  }

  /**
   * Frames [start, end) in order. Painting runs ahead on every page, but at
   * most `2 × concurrency` frames are held in memory at once.
   */
  async *frames(start: number, end: number): AsyncGenerator<Buffer> {
    const window = this.pages.length * 2;
    const inflight: Promise<Buffer>[] = [];
    let next = start;
    while (next < end && inflight.length < window) inflight.push(this.schedule(next++));
    while (inflight.length) {
      const frame = await inflight.shift()!;
      if (next < end) inflight.push(this.schedule(next++));
      yield frame;
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.chains);
    if (this.ownedBrowsers.length) await Promise.all(this.ownedBrowsers.map((b) => b.close()));
    else await Promise.all(this.pages.map((p) => p.page.close()));
  }

  private schedule(frame: number): Promise<Buffer> {
    if (activeScenes(this.project, frame).length === 0) {
      this.stats.empty++;
      this.emptyFrame ??= this.paintOnPage(0, "");
      return this.emptyFrame;
    }

    const html = renderFrameHtml(this.project, frame);
    const cached = this.cache.get(html);
    if (cached) {
      this.stats.reused++;
      return cached;
    }
    this.stats.painted++;
    const result = this.paintOnPage(frame % this.pages.length, html);
    this.cache.set(html, result);
    if (this.cache.size > REUSE_CACHE) this.cache.delete(this.cache.keys().next().value!);
    return result;
  }

  /** Queues a paint on one page; each page paints strictly one frame at a time. */
  private paintOnPage(index: number, html: string): Promise<Buffer> {
    const { page, cdp } = this.pages[index]!;
    const result = this.chains[index]!.then(async () => {
      await page.evaluate((markup) => {
        document.getElementById("root")!.innerHTML = markup;
      }, html);
      // Direct CDP capture: still lossless PNG, but with fast compression. Several
      // times quicker than page.screenshot(), which also injects styles per call.
      const { data } = await cdp.send("Page.captureScreenshot", {
        format: "png",
        optimizeForSpeed: true,
        captureBeyondViewport: false,
      });
      return Buffer.from(data, "base64");
    });
    this.chains[index] = result.catch(() => undefined);
    return result;
  }
}
