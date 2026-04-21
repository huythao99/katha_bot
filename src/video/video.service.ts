import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TiktokService } from '../tiktok/tiktok.service';
import { QueueService, VideoJob } from '../queue/queue.service';
import { KlingProvider } from './providers/kling.provider';
import { VideoGenerateOptions } from './providers/video-provider.interface';
import type { VideoClip } from './providers/video-provider.interface';

@Injectable()
export class VideoService implements OnModuleInit {
  private readonly logger = new Logger(VideoService.name);

  constructor(
    private config: ConfigService,
    private tiktok: TiktokService,
    private queue: QueueService,
    private kling: KlingProvider,
  ) {}

  onModuleInit() {
    this.queue.registerHandler((job) => this.processJob(job));
  }

  setCallbacks(
    onReady: (job: VideoJob) => void,
    onFailed: (job: VideoJob) => void,
  ) {
    this.queue.onJobDone(onReady);
    this.queue.onJobFailed(onFailed);
  }

  async queueFromTiktok(url: string, chatId: number, quality: '720p' | '1080p') {
    return this.queue.add({ type: 'tiktok', url, quality }, chatId);
  }

  async queueFromImage(imageUrl: string, prompt: string, chatId: number, quality: '720p' | '1080p') {
    return this.queue.add({ type: 'image', imageUrl, prompt, quality }, chatId);
  }

  getJob(id: string) {
    return this.queue.getJob(id);
  }

  private async processJob(job: VideoJob) {
    this.logger.log(`[Job ${job.id}] Provider: Kling AI`);

    let options: VideoGenerateOptions;

    if (job.input.type === 'tiktok') {
      const product = await this.tiktok.scrapeProduct(job.input.url);
      this.logger.log(`[Job ${job.id}] Scraped: ${product.title}`);
      options = {
        prompt: this.buildPromptFromProduct(product),
        title: product.title,
        imageUrl: product.images[0],
        quality: job.input.quality,
        durationSeconds: 15,
        clips: this.buildClipsFromProduct(product),
      };
    } else {
      options = {
        prompt: job.input.prompt,
        imageUrl: job.input.imageUrl,
        quality: job.input.quality,
        durationSeconds: Number(this.config.get('VIDEO_DURATION_SECONDS', 5)),
      };
    }

    const result = await this.kling.generateVideo(options);
    job.outputPath = result.videoPath;
  }

  private buildClipsFromProduct(product: { title: string; description: string; price: string }): VideoClip[] {
    const { action, bodyParts } = this.inferPracticalUse(product.title, product.description);

    return [
      {
        // Clip 1 (5s): product hero shot — no person
        duration: 5,
        prompt: [
          `Hero product showcase of "${product.title}".`,
          `The product appears exactly as in the reference image — preserve all colors, shape, and design precisely.`,
          `Product rests on a clean minimal surface, gently lit from above and sides.`,
          `Camera begins wide, slowly pushes in to reveal key details: texture, finish, and distinctive design features.`,
          product.description ? `Visual focus: ${product.description}.` : '',
          `Some frames shift to a slightly stylized, artistic render — vivid colors, cinematic depth of field — to make the product pop visually.`,
          `No person, no hands, no text overlays. Pure product focus.`,
        ].filter(Boolean).join(' '),
      },
      {
        // Clip 2 (10s): practical use — no face
        duration: 10,
        prompt: [
          `A person demonstrates the real practical use of "${product.title}" in an authentic lifestyle setting.`,
          `Never show the person's face — show only their ${bodyParts}.`,
          `The product looks identical to the reference image throughout every frame.`,
          `Specifically show: ${action}.`,
          product.description ? `The demonstration naturally reveals: ${product.description}.` : '',
          `Camera alternates between tight close-ups on the person interacting with the product and wider shots showing it in context.`,
          `Setting: natural daylight, real-life environment appropriate to the product's purpose.`,
          `Mood: confident, satisfying, practical. Some frames may be stylized or cinematic for visual impact.`,
          `No face visible, no text overlays, smooth flowing motion throughout.`,
        ].filter(Boolean).join(' '),
      },
    ];
  }

  static readonly CATEGORIES: Array<{ label: string; pattern: RegExp; bodyParts: string; action: string }> = [
    {
      label: 'Phone Case & Screen Protector',
      pattern: /phone case|mobile case|screen protector|iphone case|samsung case/,
      bodyParts: 'hands and wrists',
      action: 'sliding the phone into the case, snapping it securely, then confidently dropping it to demonstrate protection',
    },
    {
      label: 'Phone & Mobile Accessories',
      pattern: /charger|power bank|phone stand|phone mount|cable|phone holder|wireless charger/,
      bodyParts: 'hands and wrists',
      action: 'connecting the accessory to the phone, showing it in use during everyday activity',
    },
    {
      label: 'Bag, Backpack & Wallet',
      pattern: /bag|backpack|tote|purse|wallet|pouch|handbag|sling/,
      bodyParts: 'hands, arms, and upper body',
      action: 'opening the bag, placing items inside, zipping it closed, then lifting it over the shoulder to show capacity and comfort',
    },
    {
      label: 'Watch & Jewelry',
      pattern: /watch|bracelet|ring|necklace|jewelry|earring|pendant|bangle/,
      bodyParts: 'hands, wrists, and the body part the accessory is worn on',
      action: 'putting on the accessory, adjusting the fit, and showing it worn naturally in motion',
    },
    {
      label: 'Shoes & Footwear',
      pattern: /shoe|sneaker|boot|sandal|slipper|heel|loafer|moccasin|footwear/,
      bodyParts: 'hands, feet, and legs',
      action: 'lacing up or slipping on the shoes, standing and walking with them, showing the sole and fit from multiple angles',
    },
    {
      label: 'Socks, Stockings & Leggings',
      pattern: /sock|stocking|legging|tights/,
      bodyParts: 'hands, feet, and legs',
      action: 'pulling on the socks or leggings, smoothing them out, and walking to show fit and comfort',
    },
    {
      label: 'Swimwear',
      pattern: /swimsuit|bikini|swimwear|swim trunk|bathing suit/,
      bodyParts: 'full body from neck down',
      action: 'wearing the swimwear, moving naturally near water or a pool, showing how it fits and stays in place',
    },
    {
      label: 'Underwear & Lingerie',
      pattern: /underwear|bra|boxer|brief|lingerie|panty|thong/,
      bodyParts: 'full body from neck down',
      action: 'showing the item being worn naturally, highlighting comfort, fit, and fabric quality',
    },
    {
      label: 'Clothing & Outerwear',
      pattern: /shirt|dress|jacket|coat|pants|clothing|outfit|hoodie|sweater|blouse|skirt|cardigan|vest|tee|t-shirt/,
      bodyParts: 'hands and full body from neck down',
      action: 'putting on the clothing item, adjusting it, and showing how it fits and moves naturally while walking or posing',
    },
    {
      label: 'Hat & Headwear',
      pattern: /hat|cap|beanie|bucket hat|beret|snapback|headband/,
      bodyParts: 'hands and head (no face)',
      action: 'placing the hat on the head, adjusting the fit, and showing it from different angles',
    },
    {
      label: 'Belt, Scarf & Accessories',
      pattern: /belt|scarf|tie|glove|mitten|suspender|lanyard/,
      bodyParts: 'hands and the body part the accessory is worn on',
      action: 'wearing or fastening the accessory, showing how it complements an outfit',
    },
    {
      label: 'Sunglasses & Eyewear',
      pattern: /glasses|sunglasses|spectacles|eyewear|eyeglass|frame|lens/,
      bodyParts: 'hands and head (no face)',
      action: 'putting on the glasses, adjusting them, and showing how they look from the side and front',
    },
    {
      label: 'Skincare',
      pattern: /skin|cream|serum|moisturizer|lotion|toner|face wash|cleanser|sunscreen|spf|eye cream|face oil/,
      bodyParts: 'hands and the skin area being treated',
      action: 'dispensing the product, applying it smoothly to skin with circular motions, and showing the glowing result',
    },
    {
      label: 'Makeup & Cosmetics',
      pattern: /lipstick|foundation|mascara|eyeshadow|blush|concealer|eyeliner|lip gloss|primer|setting spray|bronzer|highlighter|makeup/,
      bodyParts: 'hands and the area being applied to (no face shown directly)',
      action: 'applying the makeup product with brush or fingers, blending it naturally, showing the finish on skin',
    },
    {
      label: 'Nail Products',
      pattern: /nail polish|nail gel|nail art|nail lamp|nail kit|manicure/,
      bodyParts: 'hands and fingers',
      action: 'applying the nail product, painting nails carefully, and showing the finished manicure result',
    },
    {
      label: 'Perfume & Fragrance',
      pattern: /perfume|cologne|fragrance|eau de|body mist|scent/,
      bodyParts: 'hands, wrists, and neck area',
      action: 'spraying the fragrance on wrist or neck, gently rubbing it in, and showing the elegant bottle',
    },
    {
      label: 'Hair Care & Styling',
      pattern: /shampoo|conditioner|hair mask|hair oil|hair spray|hair serum|hair brush|comb|hair dryer|straightener|curler|hair/,
      bodyParts: 'hands and hair',
      action: 'applying the product to hair, working it through evenly, and showing the finished styling result',
    },
    {
      label: 'Kitchen Tools & Utensils',
      pattern: /knife|cutting board|grater|peeler|spatula|ladle|tong|whisk|kitchen tool|utensil|chopper/,
      bodyParts: 'hands and forearms',
      action: 'using the tool to prepare food — chopping, stirring, or plating — in a real kitchen environment',
    },
    {
      label: 'Cookware & Appliances',
      pattern: /pan|pot|wok|cookware|blender|juicer|mixer|air fryer|rice cooker|microwave|kettle|toaster|appliance/,
      bodyParts: 'hands and forearms',
      action: 'operating the cookware or appliance with ingredients, and revealing the finished cooked result',
    },
    {
      label: 'Bottle, Cup & Drinkware',
      pattern: /bottle|cup|mug|tumbler|flask|thermos|water bottle|sippy/,
      bodyParts: 'hands and mouth area (no face)',
      action: 'filling the container, sealing it, and drinking from it naturally during an active moment',
    },
    {
      label: 'Food & Snacks',
      pattern: /food|snack|chocolate|coffee|tea|candy|cookie|biscuit|chips|sauce|seasoning|supplement drink/,
      bodyParts: 'hands and mouth area (no face)',
      action: 'opening the package, taking out or preparing the food, and enjoying it with a satisfied reaction',
    },
    {
      label: 'Health & Supplements',
      pattern: /vitamin|supplement|capsule|tablet|protein powder|health drink|thermometer|blood pressure|massage gun|massager/,
      bodyParts: 'hands and the body area being used on',
      action: 'opening the product, taking or applying it correctly, and showing the health benefit in action',
    },
    {
      label: 'Fitness & Gym',
      pattern: /dumbbell|barbell|resistance band|yoga mat|jump rope|kettlebell|gym glove|pull up|workout|fitness|exercise/,
      bodyParts: 'hands, arms, and full body from neck down',
      action: 'using the fitness equipment during a workout, showing proper form and the physical effort',
    },
    {
      label: 'Sports & Outdoor',
      pattern: /sport|running|cycling|football|basketball|tennis|badminton|racket|helmet|knee pad|elbow pad|outdoor gear/,
      bodyParts: 'hands and full body from neck down',
      action: 'actively using the sports gear during the relevant sport or outdoor activity',
    },
    {
      label: 'Headphones & Audio',
      pattern: /headphone|earphone|earbud|airpod|speaker|bluetooth audio|earpiece/,
      bodyParts: 'hands, ears, and upper body',
      action: 'putting on the headphones or earbuds, adjusting them, and showing them being used while doing an activity',
    },
    {
      label: 'Laptop & PC Accessories',
      pattern: /keyboard|mouse|laptop stand|monitor stand|usb hub|webcam|laptop bag|laptop sleeve/,
      bodyParts: 'hands and forearms',
      action: 'setting up the accessory at a desk, using it naturally while working, showing improved workflow',
    },
    {
      label: 'Camera & Photography',
      pattern: /camera|lens|tripod|gimbal|ring light|camera bag|memory card|action cam/,
      bodyParts: 'hands and forearms',
      action: 'mounting or setting up the equipment, then using it to capture a moment, showing the result on screen',
    },
    {
      label: 'Car Accessories',
      pattern: /car mount|car charger|car seat cover|steering wheel|dashboard|car organizer|car freshener|car vacuum/,
      bodyParts: 'hands and forearms',
      action: 'installing or using the car accessory inside the vehicle, showing how it improves the driving experience',
    },
    {
      label: 'Pet Products',
      pattern: /dog|cat|pet|collar|leash|pet food|pet toy|pet bed|pet bowl|aquarium|bird/,
      bodyParts: 'hands and arms',
      action: 'interacting with the pet using the product — feeding, playing, or fitting the accessory on the animal',
    },
    {
      label: 'Baby & Kids',
      pattern: /baby|infant|toddler|diaper|stroller|pacifier|baby bottle|baby monitor|kids toy|children/,
      bodyParts: 'hands and arms',
      action: 'using the product with or for a baby — feeding, soothing, or playing — showing ease of use and safety',
    },
    {
      label: 'Stationery & Books',
      pattern: /book|notebook|pen|pencil|stationery|planner|journal|marker|highlighter|eraser/,
      bodyParts: 'hands and wrists',
      action: 'opening the item, writing or reading, and showing how it feels and functions in daily use',
    },
    {
      label: 'Toys & Games',
      pattern: /toy|game|puzzle|board game|card game|lego|action figure|remote control|rc car/,
      bodyParts: 'hands and arms',
      action: 'unboxing, assembling, and actively playing with the product in an engaging, fun way',
    },
    {
      label: 'Bedding & Sleep',
      pattern: /pillow|blanket|duvet|bedding|mattress|bed sheet|comforter|sleeping bag/,
      bodyParts: 'hands, arms, and upper body',
      action: 'touching the product to feel its softness, laying on it, and showing the comfort and quality',
    },
    {
      label: 'Cleaning & Household',
      pattern: /mop|broom|vacuum|cleaner|wipe|sponge|cloth|detergent|dish soap|brush|scrub/,
      bodyParts: 'hands and arms',
      action: 'using the cleaning product on a surface, showing the before and after result clearly',
    },
    {
      label: 'Storage & Organization',
      pattern: /organizer|drawer|storage box|shelf|rack|hanger|hook|container|bin|basket/,
      bodyParts: 'hands and arms',
      action: 'placing and organizing items into the storage product, showing how it maximizes space and neatness',
    },
    {
      label: 'Lighting & LED',
      pattern: /led|strip light|bulb|desk lamp|night light|neon light|fairy light|ring light/,
      bodyParts: 'hands',
      action: 'installing or turning on the light, showing the ambiance it creates in the room',
    },
    {
      label: 'Furniture & Decor',
      pattern: /chair|desk|table|sofa|shelf|lamp|mirror|rug|curtain|wall art|decor|vase|candle/,
      bodyParts: 'hands and full body from neck down',
      action: 'placing or arranging the item in a room, showing how it transforms and elevates the living space',
    },
    {
      label: 'Garden & Plants',
      pattern: /plant|pot|soil|seed|garden|watering can|fertilizer|flower|succulent|indoor plant/,
      bodyParts: 'hands and forearms',
      action: 'planting, watering, or caring for the plant, showing the growth or the natural beauty of the result',
    },
    {
      label: 'Tools & Hardware',
      pattern: /drill|hammer|wrench|screwdriver|tape measure|toolbox|plier|saw|level|nail gun/,
      bodyParts: 'hands and forearms',
      action: 'using the tool on a real task — drilling, tightening, measuring — showing precision and ease of use',
    },
  ];

  private inferPracticalUse(title: string, description: string): { action: string; bodyParts: string } {
    const text = `${title} ${description}`.toLowerCase();

    for (const cat of VideoService.CATEGORIES) {
      if (cat.pattern.test(text)) {
        return { bodyParts: cat.bodyParts, action: cat.action };
      }
    }

    return {
      bodyParts: 'hands, arms, and relevant body parts needed to use the product',
      action: 'picking up the product, using it for its intended purpose as described by its name and features, and showcasing the value it delivers',
    };
  }

  private buildPromptFromProduct(product: { title: string; description: string; price: string }): string {
    return [
      `A short TikTok-style product advertisement for "${product.title}".`,
      product.description ? `Product details: ${product.description}.` : '',
      `Show a person naturally using the product in a lifestyle setting.`,
      `Style: realistic, cinematic, vibrant colors, suitable for social media.`,
    ].filter(Boolean).join(' ');
  }
}
