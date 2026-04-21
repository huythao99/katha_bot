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
    const { action, bodyParts, wrongBodyParts, environment, cameraShot } = this.inferPracticalUse(product.title, product.description);

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
          // 1. Subject
          `"${product.title}" product, identical to the reference image — same color, shape, texture, and design.`,
          // 2. Action
          `The product rests still, then slowly rotates to reveal all sides and key design details.`,
          // 3. Environment
          `Clean minimal surface, soft studio lighting from above and sides.`,
          // 4. Style
          product.description ? `Highlight: ${product.description}. ` : '' + `Cinematic depth of field, vivid colors, some frames slightly stylized for visual impact.`,
          // 5. Camera
          `Camera starts wide then slowly pushes in to a close-up of the product surface. Smooth deliberate movement, no cuts.`,
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
          // 1. Subject
          `${bodyParts} with "${product.title}" — product identical to reference image in color, shape, and design.`,
          // 2. Action
          `${action}.`,
          // 3. Environment
          `${environment}.`,
          // 4. Style
          product.description ? `${product.description}. ` : '' + `Realistic, authentic, natural lighting. No face visible.`,
          // 5. Camera
          `${cameraShot}. Slow smooth motion throughout.`,
        ].filter(Boolean).join(' '),
      },
    ];
  }

  static readonly CATEGORIES: Array<{ label: string; pattern: RegExp; bodyParts: string; wrongBodyParts: string; action: string; environment: string; cameraShot: string }> = [
    { label: 'Phone Case & Screen Protector', pattern: /phone case|mobile case|screen protector|iphone case|samsung case/, bodyParts: 'hands and wrists', wrongBodyParts: 'feet, legs, bare arms without phone', action: 'sliding the phone into the case, snapping it securely, then confidently dropping it to show protection', environment: 'clean desk or white tabletop, minimal background', cameraShot: 'extreme close-up macro shot of hands and phone, shallow depth of field' },
    { label: 'Phone & Mobile Accessories', pattern: /charger|power bank|phone stand|phone mount|cable|phone holder|wireless charger/, bodyParts: 'hands and wrists', wrongBodyParts: 'feet, legs, full body', action: 'connecting the accessory to the phone and using it during everyday activity', environment: 'modern desk or bedside table', cameraShot: 'close-up shot of hands and device on surface' },
    { label: 'Bag, Backpack & Wallet', pattern: /bag|backpack|tote|purse|wallet|pouch|handbag|sling/, bodyParts: 'hands and arms', wrongBodyParts: 'feet, lower legs only, face, hands reaching behind back', action: 'placing the bag on a flat surface, opening it with both hands, placing items inside, then zipping it closed and picking it up by the handles or straps from the front', environment: 'bright outdoor street or clean indoor surface', cameraShot: 'medium close-up on hands and bag on surface, then side view of person picking it up' },
    { label: 'Watch & Jewelry', pattern: /watch|bracelet|ring|necklace|jewelry|earring|pendant|bangle/, bodyParts: 'hands and wrists', wrongBodyParts: 'feet, legs, item floating without being worn', action: 'one hand placing the accessory onto the other wrist or finger, fastening it, then holding the wrist up to show the item worn clearly', environment: 'soft natural light indoors, neutral background', cameraShot: 'macro close-up on both hands and the accessory being put on, slow reveal' },
    { label: 'Shoes & Footwear', pattern: /shoe|sneaker|boot|sandal|slipper|heel|loafer|moccasin|footwear/, bodyParts: 'feet and legs', wrongBodyParts: 'hands only without feet, shoes not on feet, missing feet', action: 'lacing up the shoes with hands, then standing and walking forward showing the sole and fit', environment: 'clean floor, pavement, or wooden surface', cameraShot: 'low-angle close-up shot focused on feet and shoes, following foot movement' },
    { label: 'Socks, Stockings & Leggings', pattern: /sock|stocking|legging|tights/, bodyParts: 'feet and legs', wrongBodyParts: 'hands only without feet, upper body only, missing legs', action: 'hands pulling on the socks or leggings, then legs walking to show fit and comfort', environment: 'bedroom floor or clean indoor setting', cameraShot: 'low-angle close-up on legs and feet, panning up slowly' },
    { label: 'Swimwear', pattern: /swimsuit|bikini|swimwear|swim trunk|bathing suit/, bodyParts: 'full body from neck down', wrongBodyParts: 'face shown, upper body only, disembodied hands', action: 'wearing the swimwear, moving naturally near water, showing how it fits and stays in place', environment: 'poolside or beach with natural sunlight', cameraShot: 'full-body medium shot from neck down, slow pan' },
    { label: 'Underwear & Lingerie', pattern: /underwear|bra|boxer|brief|lingerie|panty|thong/, bodyParts: 'full body from neck down', wrongBodyParts: 'face shown, hands only without garment on body', action: 'wearing the item naturally, highlighting comfort, fit, and fabric quality with gentle movement', environment: 'bright clean bedroom with soft natural light', cameraShot: 'full-body medium shot from neck down, steady' },
    { label: 'Clothing & Outerwear', pattern: /shirt|dress|jacket|coat|pants|clothing|outfit|hoodie|sweater|blouse|skirt|cardigan|vest|tee|t-shirt/, bodyParts: 'full body from neck down', wrongBodyParts: 'face shown, hands only without clothes, item not being worn', action: 'putting on the clothing, adjusting it, then walking naturally to show how it fits and moves', environment: 'bright room or outdoor lifestyle setting', cameraShot: 'medium full-body shot from neck down, following movement' },
    { label: 'Hat & Headwear', pattern: /hat|cap|beanie|bucket hat|beret|snapback|headband/, bodyParts: 'hands, top and back of head with hat on (no face)', wrongBodyParts: 'face shown, hands only without hat, hat floating off head', action: 'both hands holding the hat, placing it down onto the head from above, adjusting it, then camera moves to side and back profile to show it worn', environment: 'outdoor or casual indoor lifestyle setting', cameraShot: 'close-up on hands placing hat on head, then side and back profile shot — never front face' },
    { label: 'Belt, Scarf & Accessories', pattern: /belt|scarf|tie|glove|mitten|suspender|lanyard/, bodyParts: 'the body part the accessory is worn on with hands', wrongBodyParts: 'accessory not being worn, floating item, wrong body part shown', action: 'fastening or wearing the accessory, showing it in use as part of an outfit', environment: 'neutral indoor or outdoor lifestyle background', cameraShot: 'medium close-up on the body part wearing the accessory' },
    { label: 'Sunglasses & Eyewear', pattern: /glasses|sunglasses|spectacles|eyewear|eyeglass|frame|lens/, bodyParts: 'hands and strict side profile of head (no front face)', wrongBodyParts: 'front face shown directly, glasses floating, face revealed at any point', action: 'hands holding the glasses and sliding them onto the face from the side, then camera stays on strict side-profile showing the glasses worn, then moves to back-of-head angle', environment: 'bright outdoor or well-lit indoor setting', cameraShot: 'strict side-profile close-up only — camera never moves to front face, side and back angles only' },
    { label: 'Skincare', pattern: /skin|cream|serum|moisturizer|lotion|toner|face wash|cleanser|sunscreen|spf|eye cream|face oil/, bodyParts: 'hands and forearm or neck skin area', wrongBodyParts: 'face shown directly, feet, legs, hands without skin contact', action: 'dispensing the product onto fingers and applying it to skin with smooth circular motions, showing glowing result', environment: 'clean bathroom counter or vanity with soft lighting', cameraShot: 'extreme close-up on hands applying product to skin surface' },
    { label: 'Makeup & Cosmetics', pattern: /lipstick|foundation|mascara|eyeshadow|blush|concealer|eyeliner|lip gloss|primer|setting spray|bronzer|highlighter|makeup/, bodyParts: 'hands and the skin area being applied to (no direct face)', wrongBodyParts: 'front face shown directly, feet, legs, product not touching skin', action: 'applying the makeup with brush or fingers, blending smoothly onto skin', environment: 'vanity or makeup table with warm natural lighting', cameraShot: 'extreme close-up on hands and skin surface, product application in focus' },
    { label: 'Nail Products', pattern: /nail polish|nail gel|nail art|nail lamp|nail kit|manicure/, bodyParts: 'hands and fingers', wrongBodyParts: 'feet, full body, face', action: 'carefully painting the nails with steady strokes, then showing the finished manicure result', environment: 'clean table with soft warm lighting', cameraShot: 'extreme close-up macro shot of fingernails being painted' },
    { label: 'Perfume & Fragrance', pattern: /perfume|cologne|fragrance|eau de|body mist|scent/, bodyParts: 'hands and wrist skin', wrongBodyParts: 'feet, legs, face shown directly', action: 'holding the bottle elegantly, spraying onto the wrist, gently rubbing it in', environment: 'elegant minimal interior with soft side lighting', cameraShot: 'close-up on hands and wrist, bottle in foreground' },
    { label: 'Hair Care & Styling', pattern: /shampoo|conditioner|hair mask|hair oil|hair spray|hair serum|hair brush|comb|hair dryer|straightener|curler|hair/, bodyParts: 'hands and back or top of head with hair (no front face)', wrongBodyParts: 'front face shown, feet, legs, hands without hair contact', action: 'hands working the product through hair from behind — fingers running through strands from the back, then showing the finished styled hair from behind and side', environment: 'bathroom or bedroom with natural light', cameraShot: 'close-up from behind the head — hands visible in hair, camera stays behind and to the side, never front face' },
    { label: 'Kitchen Tools & Utensils', pattern: /knife|cutting board|grater|peeler|spatula|ladle|tong|whisk|kitchen tool|utensil|chopper/, bodyParts: 'hands and forearms', wrongBodyParts: 'feet, legs, face', action: 'using the tool to prepare food — chopping, stirring, or plating on a kitchen counter', environment: 'real kitchen counter with ingredients and natural light', cameraShot: 'close-up overhead or eye-level shot of hands and tool in use' },
    { label: 'Cookware & Appliances', pattern: /pan|pot|wok|cookware|blender|juicer|mixer|air fryer|rice cooker|microwave|kettle|toaster|appliance/, bodyParts: 'hands and forearms', wrongBodyParts: 'feet, legs, face', action: 'operating the cookware with ingredients, then revealing the cooked result', environment: 'home kitchen counter with steam and ingredients', cameraShot: 'medium close-up showing hands, cookware, and food together' },
    { label: 'Bottle, Cup & Drinkware', pattern: /bottle|cup|mug|tumbler|flask|thermos|water bottle|sippy/, bodyParts: 'hands holding the container', wrongBodyParts: 'feet, legs, face shown', action: 'filling the container, sealing it, then raising it to drink during an active moment', environment: 'outdoor or gym setting with natural light', cameraShot: 'close-up on hands holding the container, slight upward tilt' },
    { label: 'Food & Snacks', pattern: /food|snack|chocolate|coffee|tea|candy|cookie|biscuit|chips|sauce|seasoning|supplement drink/, bodyParts: 'hands and lower chin area (no full face)', wrongBodyParts: 'feet, legs, full face shown', action: 'opening the package, preparing the food, then enjoying it with a satisfied reaction', environment: 'casual home kitchen table or outdoor café setting', cameraShot: 'close-up on hands and food, slight reveal of lower chin when eating' },
    { label: 'Health & Supplements', pattern: /vitamin|supplement|capsule|tablet|protein powder|health drink|thermometer|blood pressure|massage gun|massager/, bodyParts: 'hands and the specific body area being treated', wrongBodyParts: 'face shown, incorrect body part, product not contacting body', action: 'taking or applying the product correctly, showing the benefit in action on the relevant body area', environment: 'home wellness space or gym with clean background', cameraShot: 'close-up on hands and the body area being treated' },
    { label: 'Fitness & Gym', pattern: /dumbbell|barbell|resistance band|yoga mat|jump rope|kettlebell|gym glove|pull up|workout|fitness|exercise/, bodyParts: 'arms, hands, and full body from neck down', wrongBodyParts: 'face shown, static pose, equipment not being used', action: 'performing an exercise with the equipment, showing proper form and physical effort', environment: 'gym or outdoor workout space with natural or gym lighting', cameraShot: 'dynamic medium shot following body movement, full body from neck down' },
    { label: 'Sports & Outdoor', pattern: /sport|running|cycling|football|basketball|tennis|badminton|racket|helmet|knee pad|elbow pad|outdoor gear/, bodyParts: 'full body from neck down in motion', wrongBodyParts: 'face shown, static standing pose, gear not in use', action: 'actively using the gear in the relevant sport or outdoor activity with full body movement', environment: 'outdoor sports field, court, or trail', cameraShot: 'dynamic medium to wide shot following the body in motion' },
    { label: 'Headphones & Audio', pattern: /headphone|earphone|earbud|airpod|speaker|bluetooth audio|earpiece/, bodyParts: 'hands and side profile of head and upper body (no front face)', wrongBodyParts: 'front face shown, feet, legs, headphones floating off ears', action: 'hands bringing headphones up and placing them over ears from above, adjusting fit, then side-profile shot showing them worn while the person relaxes or moves', environment: 'casual indoor or outdoor lifestyle setting', cameraShot: 'side-profile medium close-up on head and shoulders — hands visible placing headphones, then steady side shot' },
    { label: 'Laptop & PC Accessories', pattern: /keyboard|mouse|laptop stand|monitor stand|usb hub|webcam|laptop bag|laptop sleeve/, bodyParts: 'hands and forearms on a desk', wrongBodyParts: 'feet, legs, face, hands without accessory', action: 'setting up and using the accessory at a desk, showing improved workflow', environment: 'clean modern home office desk', cameraShot: 'overhead or eye-level close-up on hands and desk setup' },
    { label: 'Camera & Photography', pattern: /camera|lens|tripod|gimbal|ring light|camera bag|memory card|action cam/, bodyParts: 'hands and forearms holding the equipment', wrongBodyParts: 'feet, legs, face shown', action: 'setting up or using the equipment to capture a moment, showing the result on screen', environment: 'creative studio or outdoor photography setting', cameraShot: 'medium close-up on hands gripping equipment, equipment in sharp focus' },
    { label: 'Car Accessories', pattern: /car mount|car charger|car seat cover|steering wheel|dashboard|car organizer|car freshener|car vacuum/, bodyParts: 'hands and forearms inside the car cabin', wrongBodyParts: 'feet, legs, outside the car, face', action: 'installing or using the accessory inside the vehicle, showing how it improves the experience', environment: 'inside a car with natural window light', cameraShot: 'close-up inside car cabin, hands and accessory in frame' },
    { label: 'Pet Products', pattern: /dog|cat|pet|collar|leash|pet food|pet toy|pet bed|pet bowl|aquarium|bird/, bodyParts: 'hands and arms with the pet visible', wrongBodyParts: 'face shown, no pet in scene, hands without pet', action: 'feeding, playing with, or fitting the accessory on the pet using the product', environment: 'home living room or garden with natural light', cameraShot: 'medium close-up on hands and pet together, pet in sharp focus' },
    { label: 'Baby & Kids', pattern: /baby|infant|toddler|diaper|stroller|pacifier|baby bottle|baby monitor|kids toy|children/, bodyParts: 'hands and arms with baby or child visible', wrongBodyParts: 'face shown, no baby visible, product floating without use', action: 'using the product to care for or play with the baby, showing ease of use and safety', environment: 'bright clean nursery or living room', cameraShot: 'medium close-up on hands and baby together' },
    { label: 'Stationery & Books', pattern: /book|notebook|pen|pencil|stationery|planner|journal|marker|highlighter|eraser/, bodyParts: 'hands and wrists on a writing surface', wrongBodyParts: 'feet, legs, face, hands without item', action: 'opening the item, writing or reading naturally, showing how it feels and functions', environment: 'clean desk with warm ambient lighting', cameraShot: 'overhead close-up on hands and writing surface' },
    { label: 'Toys & Games', pattern: /toy|game|puzzle|board game|card game|lego|action figure|remote control|rc car/, bodyParts: 'hands and arms', wrongBodyParts: 'face shown, feet, legs, hands without toy', action: 'unboxing, assembling, and actively playing with the product in an engaging way', environment: 'bright playroom or living room floor', cameraShot: 'medium close-up on hands and toy, dynamic and playful movement' },
    { label: 'Bedding & Sleep', pattern: /pillow|blanket|duvet|bedding|mattress|bed sheet|comforter|sleeping bag/, bodyParts: 'hands, arms, and upper body resting on the product', wrongBodyParts: 'face shown, standing pose, product not being touched', action: 'touching the product to feel its softness, then laying on it to show comfort and quality', environment: 'cozy bedroom with soft warm lighting', cameraShot: 'medium close-up on body and product from neck down, slow relaxed movement' },
    { label: 'Cleaning & Household', pattern: /mop|broom|vacuum|cleaner|wipe|sponge|cloth|detergent|dish soap|brush|scrub/, bodyParts: 'hands and arms in active motion', wrongBodyParts: 'face shown, static pose, product not touching surface', action: 'using the product to clean a surface, clearly showing the before and after result', environment: 'kitchen, bathroom, or floor surface in natural light', cameraShot: 'close-up on hands and surface being cleaned, showing cleaning result' },
    { label: 'Storage & Organization', pattern: /organizer|drawer|storage box|shelf|rack|hanger|hook|container|bin|basket/, bodyParts: 'hands and arms placing and arranging items', wrongBodyParts: 'face shown, feet, legs, hands without items', action: 'placing and organizing items into the product, showing how it maximizes space and neatness', environment: 'home room or closet with natural light', cameraShot: 'medium overhead or eye-level shot of hands organizing' },
    { label: 'Lighting & LED', pattern: /led|strip light|bulb|desk lamp|night light|neon light|fairy light|ring light/, bodyParts: 'hands briefly, then the lit environment', wrongBodyParts: 'face shown, full body, hands dominating over the light effect', action: 'hands installing or switching on the light, then revealing the beautiful ambient glow it creates', environment: 'dim room transforming with the light turned on', cameraShot: 'wide room shot showing the light effect after switch-on, hands briefly visible' },
    { label: 'Furniture & Decor', pattern: /chair|desk|table|sofa|shelf|lamp|mirror|rug|curtain|wall art|decor|vase|candle/, bodyParts: 'full body from neck down interacting with the item', wrongBodyParts: 'face shown, disembodied hands only, furniture not in scene', action: 'placing or arranging the item in the room, then showing how it transforms the living space', environment: 'bright modern home interior with natural light', cameraShot: 'medium wide shot showing full furniture in the room, body from neck down' },
    { label: 'Garden & Plants', pattern: /plant|pot|soil|seed|garden|watering can|fertilizer|flower|succulent|indoor plant/, bodyParts: 'hands and forearms', wrongBodyParts: 'face shown, feet, legs, hands without plant contact', action: 'planting, watering, or tending to the plant, showing the natural beauty of the result', environment: 'garden, balcony, or indoor plant shelf with natural sunlight', cameraShot: 'close-up on hands and plant, soft natural bokeh background' },
    { label: 'Tools & Hardware', pattern: /drill|hammer|wrench|screwdriver|tape measure|toolbox|plier|saw|level|nail gun/, bodyParts: 'hands and forearms gripping the tool', wrongBodyParts: 'face shown, feet, legs, tool not in use', action: 'using the tool on a real surface — drilling, tightening, or measuring — showing precision', environment: 'workshop or home repair setting with natural light', cameraShot: 'close-up on hands and tool in action, focused on the task' },
  ];

  private inferPracticalUse(title: string, description: string): { action: string; bodyParts: string; wrongBodyParts: string; environment: string; cameraShot: string } {
    const text = `${title} ${description}`.toLowerCase();

    for (const cat of VideoService.CATEGORIES) {
      if (cat.pattern.test(text)) {
        return { bodyParts: cat.bodyParts, wrongBodyParts: cat.wrongBodyParts, action: cat.action, environment: cat.environment, cameraShot: cat.cameraShot };
      }
    }

    return {
      bodyParts: 'hands and the relevant body parts needed to use this product',
      wrongBodyParts: 'face shown, incorrect body parts unrelated to product use',
      action: 'picking up the product, using it for its intended purpose, and showcasing its value',
      environment: 'natural lifestyle setting with soft daylight',
      cameraShot: 'medium close-up on hands and product together',
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
