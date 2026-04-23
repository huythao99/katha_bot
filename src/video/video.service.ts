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
      this.logger.log(`[Job ${job.id}] Scraped: ${product.title} (${product.images.length} images)`);
      const clips = this.buildClipsFromProduct(product);
      options = {
        prompt: this.buildPromptFromProduct(product),
        title: product.title,
        imageUrl: product.images[0],
        quality: job.input.quality,
        durationSeconds: clips.length * 5,
        clips,
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

  // Each image → one 5s clip built from dynamic scene components (max 5 clips = 25s)
  private buildClipsFromProduct(product: { title: string; description: string; price: string; images: string[] }): VideoClip[] {
    const detail = this.extractProductDetail(product.title, product.description);
    const scene = this.buildSceneComponents(product.title, product.description);
    const images = product.images.slice(0, 5);

    const sharedNegative = [
      'wrong product, different product, inconsistent design, color mismatch',
      'blurry, low quality, distorted, deformed',
      'text overlay, watermark, subtitle',
      'abrupt cut, jump cut, shaky camera, unstable motion',
    ].join(', ');

    // Per-clip variation: action + camera angle change each clip while subject/environment stay consistent
    const clipVariations: Array<{ action: string; detailFocus: string; camera: string }> = [
      {
        action: scene.primaryAction,
        detailFocus: detail.visual ? `The ${detail.visual} product is shown clearly in full.` : '',
        camera: 'Wide shot, camera slowly pushes in toward the product.',
      },
      {
        action: scene.secondaryAction,
        detailFocus: scene.materialBehavior,
        camera: 'Close-up shot, shallow depth of field, product surface in sharp focus.',
      },
      {
        action: `${scene.primaryAction}, viewed from a different angle`,
        detailFocus: detail.sellingPoints ? `Highlighting: ${detail.sellingPoints}.` : scene.materialBehavior,
        camera: 'Side angle sweep, smooth tracking motion.',
      },
      {
        action: scene.secondaryAction,
        detailFocus: detail.details ? `Close-up on: ${detail.details}.` : scene.detailCloseup,
        camera: 'Macro extreme close-up, slow reveal of fine details.',
      },
      {
        action: scene.primaryAction,
        detailFocus: scene.detailCloseup,
        camera: 'Final hero shot — product centered, dramatic lighting, slow gentle zoom out.',
      },
    ];

    return images.map((imageUrl, i) => {
      const v = clipVariations[i] ?? clipVariations[0];
      return {
        duration: 5,
        cfgScale: 0.8,
        imageUrl,
        negativePrompt: sharedNegative,
        // Assembled as a flowing narrative sentence — same structure as the Gemini example
        prompt: [
          // [Subject wearing/featuring product]
          `${scene.subject} ${detail.name}${detail.visual ? ` (${detail.visual})` : ''}.`,
          // [Action] in [Environment]
          `${v.action} in ${scene.environment}.`,
          // [Material behavior / product in scene]
          `${v.detailFocus}`,
          // [Detail close-up instruction]
          `${scene.detailCloseup}.`,
          // [Application context — first clip only]
          i === 0 && detail.application ? `${detail.application}.` : '',
          // [Style]
          `${scene.style}.`,
          // [Camera]
          `${v.camera}`,
        ].filter(Boolean).join(' '),
      };
    });
  }

  // Extracts dynamic scene components from product title + description.
  // Structure mirrors: [subject] [action] in [environment]. [material behavior]. Close-up on [detail]. [style].
  private buildSceneComponents(title: string, description: string): {
    subject: string;
    primaryAction: string;
    secondaryAction: string;
    environment: string;
    materialBehavior: string;
    detailCloseup: string;
    style: string;
  } {
    const text = `${title} ${description}`.toLowerCase();

    // --- Subject: who/what is in the scene ---
    const subjectMap: Array<{ pattern: RegExp; subject: string }> = [
      { pattern: /dress|skirt|áo|silk|blouse|qipao|kimono|hanbok|sari/, subject: 'A woman wearing' },
      { pattern: /shirt|polo|tee|hoodie|sweater|jacket|coat|vest/, subject: 'A person wearing' },
      { pattern: /shoe|sneaker|boot|sandal|slipper|heel/, subject: 'A pair of' },
      { pattern: /bag|backpack|tote|handbag|purse|wallet/, subject: 'A' },
      { pattern: /watch|bracelet|ring|necklace|earring|pendant/, subject: 'A person wearing' },
      { pattern: /hat|cap|beanie/, subject: 'A person wearing' },
      { pattern: /phone|laptop|keyboard|mouse/, subject: 'A' },
      { pattern: /skincare|cream|serum|lotion/, subject: 'A close-up of' },
      { pattern: /perfume|cologne|fragrance/, subject: 'An elegant bottle of' },
    ];
    const subjectEntry = subjectMap.find(e => e.pattern.test(text));
    const subject = subjectEntry?.subject ?? 'A product shot of';

    // --- Primary action: main motion in the scene ---
    const actionMap: Array<{ pattern: RegExp; primary: string; secondary: string }> = [
      { pattern: /dress|skirt|silk|áo|blouse/, primary: 'walking slowly', secondary: 'turning gracefully' },
      { pattern: /shoe|sneaker|boot|sandal/, primary: 'stepping forward on a clean surface', secondary: 'rotating to reveal the sole and profile' },
      { pattern: /bag|backpack|tote/, primary: 'placed elegantly on a surface, gently handled', secondary: 'lifted and held naturally' },
      { pattern: /watch|bracelet|ring/, primary: 'worn on a wrist, catching the light as it moves', secondary: 'placed on a surface, slowly rotating' },
      { pattern: /jacket|coat|hoodie/, primary: 'draped and gently swaying', secondary: 'laid flat, slowly revealed from top to bottom' },
      { pattern: /phone|laptop|keyboard/, primary: 'placed on a clean desk, in focus', secondary: 'slowly rotating on its axis' },
      { pattern: /skincare|cream|serum/, primary: 'dispensed and applied to smooth skin', secondary: 'product bottle slowly rotating' },
      { pattern: /perfume|fragrance/, primary: 'held elegantly, mist released in a soft arc', secondary: 'placed on a marble surface, rotating slowly' },
    ];
    const actionEntry = actionMap.find(e => e.pattern.test(text));
    const primaryAction = actionEntry?.primary ?? 'displayed on a clean surface, slowly rotating';
    const secondaryAction = actionEntry?.secondary ?? 'revealed from multiple angles with smooth camera movement';

    // --- Environment: location + lighting ---
    const envMap: Array<{ pattern: RegExp; environment: string }> = [
      { pattern: /silk|áo|dress|skirt|traditional|hanbok|kimono|sari|qipao/, environment: 'a sunlit heritage location with warm golden-hour light' },
      { pattern: /outdoor|sport|running|gym|fitness/, environment: 'an outdoor lifestyle setting with natural sunlight' },
      { pattern: /skincare|makeup|beauty|serum|cream/, environment: 'a clean white vanity with soft diffused natural light' },
      { pattern: /perfume|fragrance|cologne/, environment: 'an elegant minimal interior with marble surface and side lighting' },
      { pattern: /shoe|sneaker|boot/, environment: 'a clean floor surface with soft studio lighting' },
      { pattern: /watch|jewelry|ring|bracelet/, environment: 'a minimal dark surface with dramatic spotlight' },
      { pattern: /phone|laptop|keyboard|tech/, environment: 'a modern clean desk setup with soft ambient light' },
      { pattern: /bag|wallet|purse/, environment: 'a clean lifestyle backdrop with warm natural light' },
    ];
    const envEntry = envMap.find(e => e.pattern.test(text));
    const environment = envEntry?.environment ?? 'a clean minimal studio with soft directional lighting';

    // --- Material behavior: how the product looks/feels in the scene ---
    const materialBehaviorMap: Array<{ pattern: RegExp; behavior: string }> = [
      { pattern: /silk|satin|chiffon|tơ|lụa/, behavior: 'The lightweight fabric gently drifts and catches the light, revealing its natural sheen' },
      { pattern: /leather|suede/, behavior: 'The rich leather surface catches the light, showing its texture and depth' },
      { pattern: /wool|knit|cashmere/, behavior: 'The soft fabric drapes naturally, its texture visible in the gentle light' },
      { pattern: /metal|stainless steel|aluminum/, behavior: 'The polished surface reflects light with a premium metallic gleam' },
      { pattern: /glass|crystal|transparent/, behavior: 'Light passes through the material, creating beautiful refractions' },
      { pattern: /cotton|linen|canvas/, behavior: 'The fabric moves naturally, its weave visible in the warm lighting' },
    ];
    const behaviorEntry = materialBehaviorMap.find(e => e.pattern.test(text));
    const materialBehavior = behaviorEntry?.behavior ?? 'The product surface catches the light, emphasizing its quality and finish';

    // --- Detail close-up: what specific detail to show ---
    const detailMap: Array<{ pattern: RegExp; detail: string }> = [
      { pattern: /embroid|thêu|flower|floral/, detail: 'Close-up on the intricate embroidery patterns and delicate floral details' },
      { pattern: /stitch|seam|hem/, detail: 'Close-up on the precise stitching and clean finishing' },
      { pattern: /sole|outsole/, detail: 'Close-up on the textured sole pattern and heel construction' },
      { pattern: /zipper|buckle|clasp|lock/, detail: 'Close-up on the hardware — zipper, clasp, and metal details' },
      { pattern: /logo|brand|label/, detail: 'Close-up on the brand logo and label, crisp and centered' },
      { pattern: /crystal|gem|stone|diamond/, detail: 'Close-up on the gemstone settings catching and refracting light' },
      { pattern: /print|pattern|graphic/, detail: 'Close-up on the printed pattern and color accuracy' },
      { pattern: /button|bow|ribbon/, detail: 'Close-up on the button detailing and bow embellishments' },
    ];
    const detailEntry = detailMap.find(e => e.pattern.test(text));
    const detailCloseup = detailEntry?.detail ?? 'Close-up on the surface texture, material quality, and product finishing';

    // --- Style: cinematic quality descriptor ---
    const styleMap: Array<{ pattern: RegExp; style: string }> = [
      { pattern: /silk|áo|dress|traditional|hanbok|kimono/, style: 'Warm cinematic lighting, high-quality fashion photography, 4K' },
      { pattern: /sport|gym|fitness|running/, style: 'Dynamic natural lighting, commercial sports photography, 4K' },
      { pattern: /skincare|beauty|makeup/, style: 'Soft diffused lighting, premium beauty campaign style, 4K' },
      { pattern: /perfume|fragrance/, style: 'Dramatic luxury lighting, high-end fragrance advertisement style, 4K' },
      { pattern: /tech|phone|laptop|keyboard/, style: 'Clean modern lighting, premium tech product photography, 4K' },
      { pattern: /jewelry|watch|ring|bracelet/, style: 'Dramatic spotlight, luxury jewelry advertisement style, 4K' },
    ];
    const styleEntry = styleMap.find(e => e.pattern.test(text));
    const style = styleEntry?.style ?? 'Warm cinematic lighting, high-quality commercial product photography, 4K';

    return { subject, primaryAction, secondaryAction, environment, materialBehavior, detailCloseup, style };
  }

  private extractProductDetail(title: string, description: string): {
    name: string;
    visual: string;
    application: string;
    details: string;
    sellingPoints: string;
  } {
    const text = `${title} ${description}`;

    // Extract color mentions
    const colorMatch = text.match(/\b(black|white|red|blue|green|yellow|pink|purple|orange|brown|grey|gray|silver|gold|rose gold|navy|beige|cream|nude|transparent|clear|multicolor|rainbow)\b/gi);
    const colors = colorMatch ? [...new Set(colorMatch.map(c => c.toLowerCase()))].join(', ') : '';

    // Extract material mentions
    const materialMatch = text.match(/\b(leather|suede|canvas|mesh|nylon|polyester|cotton|wool|silk|linen|rubber|plastic|metal|aluminum|stainless steel|wood|bamboo|glass|ceramic|foam|silicone|velvet|denim)\b/gi);
    const materials = materialMatch ? [...new Set(materialMatch.map(m => m.toLowerCase()))].join(', ') : '';

    // Extract size/dimension mentions
    const sizeMatch = text.match(/\b(\d+\s*cm|\d+\s*mm|\d+\s*inch|\d+\s*L|\d+\s*ml|\d+\s*oz|\bXS\b|\bS\b|\bM\b|\bL\b|\bXL\b|\bXXL\b|size\s*\d+|\d+\s*x\s*\d+)/gi);
    const sizes = sizeMatch ? [...new Set(sizeMatch)].join(', ') : '';

    // Build visual string from extracted attributes
    const visualParts = [colors, materials, sizes].filter(Boolean);
    const visual = visualParts.length > 0 ? visualParts.join(', ') : '';

    // Extract key selling point / feature keywords
    const sellingPointKeywords = [
      'waterproof', 'water resistant', 'breathable', 'lightweight', 'durable', 'anti-slip',
      'fast charging', 'wireless', 'noise cancelling', 'noise canceling', 'bluetooth',
      'adjustable', 'foldable', 'portable', 'reusable', 'eco-friendly', 'biodegradable',
      'UV protection', 'SPF', 'anti-bacterial', 'hypoallergenic', 'organic', 'natural',
      'non-stick', 'heat resistant', 'washable', 'machine washable', 'quick dry',
      'stretchable', 'elastic', 'double-sided', 'multi-purpose', 'all-in-one',
      'smart', 'automatic', 'ergonomic', 'anti-scratch', 'shockproof', 'impact resistant',
      'odor resistant', 'sweat-proof', 'stain resistant', 'wrinkle free',
    ];
    const foundPoints = sellingPointKeywords.filter(kw =>
      new RegExp(`\\b${kw}\\b`, 'i').test(text),
    );
    const sellingPoints = foundPoints.length > 0 ? foundPoints.join(', ') : '';

    // Description sentences — use all of them (no truncation)
    const descSentences = description
      ? description.split(/[.。]/).map(s => s.trim()).filter(s => s.length > 8)
      : [];

    // Application: first meaningful sentence
    const application = descSentences[0] ?? '';

    // Details: all remaining sentences joined (up to 300 chars for rich description)
    const detailsRaw = descSentences.slice(1).join('. ');
    const details = detailsRaw.length > 300 ? detailsRaw.substring(0, 300) + '...' : detailsRaw;

    return {
      name: title,
      visual,
      application,
      details,
      sellingPoints,
    };
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

private buildPromptFromProduct(product: { title: string; description: string; price: string }): string {
    return [
      `A short TikTok-style product advertisement for "${product.title}".`,
      product.description ? `Product details: ${product.description}.` : '',
      `Show a person naturally using the product in a lifestyle setting.`,
      `Style: realistic, cinematic, vibrant colors, suitable for social media.`,
    ].filter(Boolean).join(' ');
  }
}
