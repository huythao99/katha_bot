import { Injectable, Logger } from '@nestjs/common';
import * as puppeteer from 'puppeteer';

export interface TiktokProduct {
  title: string;
  description: string;
  price: string;
  images: string[];
  url: string;
}

@Injectable()
export class TiktokService {
  private readonly logger = new Logger(TiktokService.name);

  isTiktokLink(text: string): boolean {
    return /https?:\/\/(www\.)?(tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com)/.test(text);
  }

  async scrapeProduct(url: string): Promise<TiktokProduct> {
    this.logger.log(`Scraping TikTok product: ${url}`);

    // Try extracting from og_info query param first (no Puppeteer needed)
    const fromUrl = this.extractFromUrlParams(url);
    if (fromUrl) {
      this.logger.log(`Extracted from URL params: ${fromUrl.title}`);
      return fromUrl;
    }

    // Fallback to Puppeteer
    return this.scrapeWithPuppeteer(url);
  }

  // ------------------------------------------------------------------
  // Extract product info from og_info query parameter in the URL
  // TikTok Shop share links embed title + image in the URL itself
  // ------------------------------------------------------------------
  private extractFromUrlParams(url: string): TiktokProduct | null {
    try {
      const parsed = new URL(url);
      const ogInfoRaw = parsed.searchParams.get('og_info');
      if (!ogInfoRaw) return null;

      const ogInfo = JSON.parse(decodeURIComponent(ogInfoRaw));
      const title: string = ogInfo.title
        ? decodeURIComponent(ogInfo.title.replace(/\+/g, ' '))
        : '';
      const image: string = ogInfo.image ?? '';

      if (!title) return null;

      return {
        title,
        description: '',
        price: '',
        images: image ? [image] : [],
        url,
      };
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------
  // Puppeteer fallback for non-share links
  // ------------------------------------------------------------------
  private async scrapeWithPuppeteer(url: string): Promise<TiktokProduct> {
    let browser: puppeteer.Browser;
    try {
      browser = await puppeteer.launch({
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });

      const page = await browser.newPage();
      await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      );

      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      const finalUrl = page.url();
      this.logger.log(`Resolved URL: ${finalUrl}`);

      await page.waitForSelector('h1, [class*="title"], [class*="product-title"]', {
        timeout: 15000,
      }).catch(() => null);

      const product = await page.evaluate(() => {
        const getText = (selectors: string[]) => {
          for (const s of selectors) {
            const el = document.querySelector(s);
            if (el?.textContent?.trim()) return el.textContent.trim();
          }
          return '';
        };

        const title = getText(['h1', '[class*="product-title"]', '[class*="title"]', '[data-e2e="product-title"]']);
        const description = getText(['[class*="description"]', '[class*="product-desc"]', '[data-e2e="product-desc"]']);
        const price = getText(['[class*="price"]', '[data-e2e="product-price"]', '[class*="Price"]']);

        const images: string[] = [];
        document.querySelectorAll('img[src*="tiktok"], img[src*="tiktokcdn"]').forEach((img: HTMLImageElement) => {
          if (img.src && !images.includes(img.src)) images.push(img.src);
        });

        return { title, description, price, images: images.slice(0, 4) };
      });

      return {
        ...product,
        url: finalUrl,
        title: product.title || 'TikTok Shop Product',
        description: product.description || '',
      };
    } finally {
      if (browser) await browser.close();
    }
  }
}
