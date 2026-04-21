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
    const { action, bodyParts, wrongBodyParts } = this.inferPracticalUse(product.title, product.description);

    const sharedNegative = [
      'face, head, portrait',
      'wrong product, different product, inconsistent design, color mismatch',
      'blurry, low quality, distorted, deformed',
      'text overlay, watermark, subtitle',
      'abrupt cut, jump cut, shaky camera, unstable motion',
    ].join(', ');

    return [
      {
        // Clip 1 (5s): product hero shot — no person
        duration: 5,
        cfgScale: 0.7,
        negativePrompt: [
          'person, human, hands, body',
          sharedNegative,
        ].join(', '),
        prompt: [
          `Hero product showcase of "${product.title}".`,
          `The product appears exactly as in the reference image — preserve all colors, shape, texture, and design precisely.`,
          `Product rests on a clean minimal surface, gently lit from above and sides.`,
          `Camera begins wide, slowly and smoothly pushes in to reveal key details: texture, finish, and distinctive design features.`,
          `All camera movements are slow, deliberate, and cinematic — no sudden cuts.`,
          product.description ? `Visual focus: ${product.description}.` : '',
          `Some frames shift to a slightly stylized, artistic render — vivid colors, cinematic depth of field — to make the product pop visually.`,
          `No person, no hands, no text overlays. Pure product focus.`,
        ].filter(Boolean).join(' '),
      },
      {
        // Clip 2 (10s): practical use — no face
        duration: 10,
        cfgScale: 0.8,
        negativePrompt: [
          sharedNegative,
          'product not visible, product too small',
          wrongBodyParts,
        ].join(', '),
        prompt: [
          `Close-up shot of ${bodyParts} ${action}.`,
          `The product is "${product.title}" and looks exactly as in the reference image — same color, shape, and design.`,
          product.description ? `${product.description}.` : '',
          `Natural daylight. Slow smooth motion. No face visible.`,
        ].filter(Boolean).join(' '),
      },
    ];
  }

  static readonly CATEGORIES: Array<{ label: string; pattern: RegExp; bodyParts: string; wrongBodyParts: string; action: string }> = [
    { label: 'Phone Case & Screen Protector', pattern: /phone case|mobile case|screen protector|iphone case|samsung case/, bodyParts: 'hands and wrists', wrongBodyParts: 'feet, legs, bare arms without phone', action: 'sliding the phone into the case, snapping it securely, then confidently dropping it to demonstrate protection' },
    { label: 'Phone & Mobile Accessories', pattern: /charger|power bank|phone stand|phone mount|cable|phone holder|wireless charger/, bodyParts: 'hands and wrists', wrongBodyParts: 'feet, legs, full body shot', action: 'connecting the accessory to the phone, showing it in use during everyday activity' },
    { label: 'Bag, Backpack & Wallet', pattern: /bag|backpack|tote|purse|wallet|pouch|handbag|sling/, bodyParts: 'hands, arms, and upper body', wrongBodyParts: 'feet visible, lower legs only, face', action: 'opening the bag, placing items inside, zipping it closed, then lifting it over the shoulder to show capacity and comfort' },
    { label: 'Watch & Jewelry', pattern: /watch|bracelet|ring|necklace|jewelry|earring|pendant|bangle/, bodyParts: 'hands, wrists, and the body part the item is worn on', wrongBodyParts: 'feet, legs, item floating without being worn', action: 'putting on the accessory, adjusting the fit, and showing it worn naturally in motion' },
    { label: 'Shoes & Footwear', pattern: /shoe|sneaker|boot|sandal|slipper|heel|loafer|moccasin|footwear/, bodyParts: 'feet and legs (with hands visible briefly to lace up)', wrongBodyParts: 'hands only without feet, shoes not on feet, missing feet and legs', action: 'lacing up or slipping on the shoes, standing and walking, showing the sole and fit from multiple angles' },
    { label: 'Socks, Stockings & Leggings', pattern: /sock|stocking|legging|tights/, bodyParts: 'feet, legs, and hands briefly', wrongBodyParts: 'hands only without feet, missing legs and feet, upper body only', action: 'pulling on the socks or leggings, smoothing them out, and walking to show fit and comfort' },
    { label: 'Swimwear', pattern: /swimsuit|bikini|swimwear|swim trunk|bathing suit/, bodyParts: 'full body from neck down', wrongBodyParts: 'face shown, upper body only without lower body, disembodied hands', action: 'wearing the swimwear, moving naturally near water or a pool, showing how it fits and stays in place' },
    { label: 'Underwear & Lingerie', pattern: /underwear|bra|boxer|brief|lingerie|panty|thong/, bodyParts: 'full body from neck down', wrongBodyParts: 'face shown, hands only without the garment on body', action: 'showing the item being worn naturally, highlighting comfort, fit, and fabric quality' },
    { label: 'Clothing & Outerwear', pattern: /shirt|dress|jacket|coat|pants|clothing|outfit|hoodie|sweater|blouse|skirt|cardigan|vest|tee|t-shirt/, bodyParts: 'full body from neck down, hands visible', wrongBodyParts: 'face shown, hands only without clothes visible, item not being worn', action: 'putting on the clothing item, adjusting it, and showing how it fits and moves naturally while walking or posing' },
    { label: 'Hat & Headwear', pattern: /hat|cap|beanie|bucket hat|beret|snapback|headband/, bodyParts: 'head and upper body from neck down (no face), hands briefly', wrongBodyParts: 'face shown, hands only without hat on head, hat floating without being worn', action: 'placing the hat on the head, adjusting the fit, and showing it from different angles' },
    { label: 'Belt, Scarf & Accessories', pattern: /belt|scarf|tie|glove|mitten|suspender|lanyard/, bodyParts: 'hands and the body part the accessory is worn on', wrongBodyParts: 'accessory not being worn, floating item, wrong body part', action: 'wearing or fastening the accessory, showing how it complements an outfit' },
    { label: 'Sunglasses & Eyewear', pattern: /glasses|sunglasses|spectacles|eyewear|eyeglass|frame|lens/, bodyParts: 'head and ears from neck up (no face), hands briefly', wrongBodyParts: 'face shown directly, glasses floating without being worn, wrong angle showing face', action: 'putting on the glasses, adjusting them, and showing how they look from the side and back' },
    { label: 'Skincare', pattern: /skin|cream|serum|moisturizer|lotion|toner|face wash|cleanser|sunscreen|spf|eye cream|face oil/, bodyParts: 'hands and the skin area being treated (arm, neck, or hand skin)', wrongBodyParts: 'feet, legs, face shown directly, hands only without skin contact', action: 'dispensing the product onto fingers, applying it smoothly to skin with circular motions, showing the glowing result' },
    { label: 'Makeup & Cosmetics', pattern: /lipstick|foundation|mascara|eyeshadow|blush|concealer|eyeliner|lip gloss|primer|setting spray|bronzer|highlighter|makeup/, bodyParts: 'hands and the skin area being applied to', wrongBodyParts: 'face shown directly, feet, legs, product not touching skin', action: 'applying the makeup product with brush or fingers, blending it naturally on skin' },
    { label: 'Nail Products', pattern: /nail polish|nail gel|nail art|nail lamp|nail kit|manicure/, bodyParts: 'hands and fingers', wrongBodyParts: 'feet shown for hand nail products, full body shot, face', action: 'applying the nail product, painting nails carefully, and showing the finished manicure result' },
    { label: 'Perfume & Fragrance', pattern: /perfume|cologne|fragrance|eau de|body mist|scent/, bodyParts: 'hands, wrists, and neck area', wrongBodyParts: 'feet, legs, face shown directly, hands only without spray interaction', action: 'spraying the fragrance on wrist or neck, gently rubbing it in, and showing the elegant bottle' },
    { label: 'Hair Care & Styling', pattern: /shampoo|conditioner|hair mask|hair oil|hair spray|hair serum|hair brush|comb|hair dryer|straightener|curler|hair/, bodyParts: 'hands and hair (back of head visible)', wrongBodyParts: 'feet, legs, face shown directly, hands only without hair visible', action: 'applying the product to hair, working it through evenly, and showing the finished styling result' },
    { label: 'Kitchen Tools & Utensils', pattern: /knife|cutting board|grater|peeler|spatula|ladle|tong|whisk|kitchen tool|utensil|chopper/, bodyParts: 'hands and forearms', wrongBodyParts: 'feet, legs, full body shot, face', action: 'using the tool to prepare food — chopping, stirring, or plating — in a real kitchen environment' },
    { label: 'Cookware & Appliances', pattern: /pan|pot|wok|cookware|blender|juicer|mixer|air fryer|rice cooker|microwave|kettle|toaster|appliance/, bodyParts: 'hands and forearms', wrongBodyParts: 'feet, legs, full body, face', action: 'operating the cookware or appliance with ingredients, and revealing the finished cooked result' },
    { label: 'Bottle, Cup & Drinkware', pattern: /bottle|cup|mug|tumbler|flask|thermos|water bottle|sippy/, bodyParts: 'hands holding the container', wrongBodyParts: 'feet, legs, face shown, hands without container', action: 'filling the container, sealing it, and drinking from it naturally during an active moment' },
    { label: 'Food & Snacks', pattern: /food|snack|chocolate|coffee|tea|candy|cookie|biscuit|chips|sauce|seasoning|supplement drink/, bodyParts: 'hands and mouth area (chin and lips only, no full face)', wrongBodyParts: 'feet, legs, full face shown, hands without food', action: 'opening the package, taking out or preparing the food, and enjoying it with a satisfied reaction' },
    { label: 'Health & Supplements', pattern: /vitamin|supplement|capsule|tablet|protein powder|health drink|thermometer|blood pressure|massage gun|massager/, bodyParts: 'hands and the body area being treated', wrongBodyParts: 'face shown, incorrect body area, product not in contact with body', action: 'opening the product, using or applying it correctly, and showing the health benefit in action' },
    { label: 'Fitness & Gym', pattern: /dumbbell|barbell|resistance band|yoga mat|jump rope|kettlebell|gym glove|pull up|workout|fitness|exercise/, bodyParts: 'arms, hands, and full body from neck down in motion', wrongBodyParts: 'face shown, static pose only, equipment not being used', action: 'using the fitness equipment during a workout, showing proper form and physical effort' },
    { label: 'Sports & Outdoor', pattern: /sport|running|cycling|football|basketball|tennis|badminton|racket|helmet|knee pad|elbow pad|outdoor gear/, bodyParts: 'full body from neck down actively moving', wrongBodyParts: 'face shown, static standing pose, gear not being used', action: 'actively using the sports gear during the relevant sport or outdoor activity' },
    { label: 'Headphones & Audio', pattern: /headphone|earphone|earbud|airpod|speaker|bluetooth audio|earpiece/, bodyParts: 'upper body from neck down with ears visible (no face), hands briefly', wrongBodyParts: 'face shown directly, feet, legs, headphones floating without being worn', action: 'putting on the headphones or earbuds, adjusting them, and showing them being used during an activity' },
    { label: 'Laptop & PC Accessories', pattern: /keyboard|mouse|laptop stand|monitor stand|usb hub|webcam|laptop bag|laptop sleeve/, bodyParts: 'hands and forearms on a desk', wrongBodyParts: 'feet, legs, full body, face, hands without accessory', action: 'setting up the accessory at a desk, using it naturally while working, showing improved workflow' },
    { label: 'Camera & Photography', pattern: /camera|lens|tripod|gimbal|ring light|camera bag|memory card|action cam/, bodyParts: 'hands and forearms', wrongBodyParts: 'feet, legs, face shown, hands without equipment', action: 'mounting or setting up the equipment, then using it to capture a moment, showing the result on screen' },
    { label: 'Car Accessories', pattern: /car mount|car charger|car seat cover|steering wheel|dashboard|car organizer|car freshener|car vacuum/, bodyParts: 'hands and forearms inside the car', wrongBodyParts: 'feet, legs, full body outside car, face', action: 'installing or using the car accessory inside the vehicle, showing how it improves the driving experience' },
    { label: 'Pet Products', pattern: /dog|cat|pet|collar|leash|pet food|pet toy|pet bed|pet bowl|aquarium|bird/, bodyParts: 'hands and arms interacting with the pet', wrongBodyParts: 'face shown, no pet visible, hands without pet or product', action: 'interacting with the pet using the product — feeding, playing, or fitting the accessory on the animal' },
    { label: 'Baby & Kids', pattern: /baby|infant|toddler|diaper|stroller|pacifier|baby bottle|baby monitor|kids toy|children/, bodyParts: 'hands and arms caring for the baby', wrongBodyParts: 'face shown, no baby or child visible, product floating', action: 'using the product with or for a baby — feeding, soothing, or playing — showing ease of use and safety' },
    { label: 'Stationery & Books', pattern: /book|notebook|pen|pencil|stationery|planner|journal|marker|highlighter|eraser/, bodyParts: 'hands and wrists on a writing surface', wrongBodyParts: 'feet, legs, full body, face, hands without item', action: 'opening the item, writing or reading, and showing how it feels and functions in daily use' },
    { label: 'Toys & Games', pattern: /toy|game|puzzle|board game|card game|lego|action figure|remote control|rc car/, bodyParts: 'hands and arms', wrongBodyParts: 'face shown, feet, legs, hands without toy', action: 'unboxing, assembling, and actively playing with the product in an engaging, fun way' },
    { label: 'Bedding & Sleep', pattern: /pillow|blanket|duvet|bedding|mattress|bed sheet|comforter|sleeping bag/, bodyParts: 'hands, arms, and upper body resting on or touching the product', wrongBodyParts: 'face shown, standing pose, product not being touched or used', action: 'touching the product to feel its softness, laying on it, and showing the comfort and quality' },
    { label: 'Cleaning & Household', pattern: /mop|broom|vacuum|cleaner|wipe|sponge|cloth|detergent|dish soap|brush|scrub/, bodyParts: 'hands and arms in action', wrongBodyParts: 'face shown, static pose, product not touching surface', action: 'using the cleaning product on a surface, showing the before and after result clearly' },
    { label: 'Storage & Organization', pattern: /organizer|drawer|storage box|shelf|rack|hanger|hook|container|bin|basket/, bodyParts: 'hands and arms placing items', wrongBodyParts: 'face shown, feet, legs, hands without items being organized', action: 'placing and organizing items into the storage product, showing how it maximizes space and neatness' },
    { label: 'Lighting & LED', pattern: /led|strip light|bulb|desk lamp|night light|neon light|fairy light|ring light/, bodyParts: 'hands briefly installing or switching on', wrongBodyParts: 'face shown, full body, hands dominating frame instead of light', action: 'installing or turning on the light, showing the beautiful ambiance it creates in the room' },
    { label: 'Furniture & Decor', pattern: /chair|desk|table|sofa|shelf|lamp|mirror|rug|curtain|wall art|decor|vase|candle/, bodyParts: 'full body from neck down interacting with the furniture', wrongBodyParts: 'face shown, disembodied hands only, furniture not in scene', action: 'placing or arranging the item in a room, showing how it transforms and elevates the living space' },
    { label: 'Garden & Plants', pattern: /plant|pot|soil|seed|garden|watering can|fertilizer|flower|succulent|indoor plant/, bodyParts: 'hands and forearms tending to the plant', wrongBodyParts: 'face shown, feet, legs, hands without plant contact', action: 'planting, watering, or caring for the plant, showing the growth or the natural beauty of the result' },
    { label: 'Tools & Hardware', pattern: /drill|hammer|wrench|screwdriver|tape measure|toolbox|plier|saw|level|nail gun/, bodyParts: 'hands and forearms using the tool', wrongBodyParts: 'face shown, feet, legs, tool not in use', action: 'using the tool on a real task — drilling, tightening, measuring — showing precision and ease of use' },
  ];

  private inferPracticalUse(title: string, description: string): { action: string; bodyParts: string; wrongBodyParts: string } {
    const text = `${title} ${description}`.toLowerCase();

    for (const cat of VideoService.CATEGORIES) {
      if (cat.pattern.test(text)) {
        return { bodyParts: cat.bodyParts, wrongBodyParts: cat.wrongBodyParts, action: cat.action };
      }
    }

    return {
      bodyParts: 'hands and the relevant body parts needed to use this product',
      wrongBodyParts: 'face shown, incorrect body parts unrelated to product use',
      action: 'picking up the product, using it for its intended purpose, and showcasing the value it delivers',
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
