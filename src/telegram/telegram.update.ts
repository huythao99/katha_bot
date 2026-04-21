import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectBot, Start, Help, Command, On, Action, Ctx, Update } from 'nestjs-telegraf';
import { Telegraf, Context, Markup } from 'telegraf';
import { TiktokService } from '../tiktok/tiktok.service';
import { VideoService } from '../video/video.service';
import { VideoJob } from '../queue/queue.service';

@Update()
@Injectable()
export class TelegramUpdate implements OnModuleInit {
  private readonly logger = new Logger(TelegramUpdate.name);
  private userQuality = new Map<number, '720p' | '1080p'>();

  constructor(
    @InjectBot() private bot: Telegraf<Context>,
    private tiktok: TiktokService,
    private video: VideoService,
  ) {}

  onModuleInit() {
    this.video.setCallbacks(
      (job) => this.sendVideo(job),
      (job) => this.sendError(job),
    );
  }

  // ------------------------------------------------------------------
  // Commands
  // ------------------------------------------------------------------

  @Start()
  async onStart(@Ctx() ctx: Context) {
    await ctx.reply(
      `Welcome to Katha Bot!\n\n` +
      `I generate product videos from TikTok Shop links or images.\n\n` +
      `How to use:\n` +
      `  Send a TikTok Shop link → auto product video\n` +
      `  Send a photo + caption → caption becomes the prompt\n\n` +
      `Commands:\n` +
      `/quality — set output quality (720p / 1080p)\n` +
      `/status <job_id> — check job progress\n` +
      `/help — show this message`,
    );
  }

  @Help()
  async onHelp(@Ctx() ctx: Context) {
    await this.onStart(ctx);
  }

  @Command('quality')
  async onQuality(@Ctx() ctx: Context) {
    await ctx.reply(
      'Choose output quality:',
      Markup.inlineKeyboard([
        [
          Markup.button.callback('720p', 'quality_720'),
          Markup.button.callback('1080p', 'quality_1080'),
        ],
      ]),
    );
  }

  @Command('status')
  async onStatus(@Ctx() ctx: Context) {
    const text = (ctx.message as any)?.text ?? '';
    const jobId = text.split(' ')[1];

    if (!jobId) {
      await ctx.reply('Usage: /status <job_id>');
      return;
    }

    const job = this.video.getJob(jobId);
    if (!job) {
      await ctx.reply(`Job not found: ${jobId}`);
      return;
    }

    await ctx.reply(
      `Job: \`${job.id}\`\n` +
      `Status: ${job.status}\n` +
      `Quality: ${job.input.quality}\n` +
      `Created: ${job.createdAt.toISOString()}` +
      (job.error ? `\nError: ${job.error}` : ''),
      { parse_mode: 'Markdown' },
    );
  }

  // ------------------------------------------------------------------
  // Inline keyboard actions
  // ------------------------------------------------------------------

  @Action('quality_720')
  async onQuality720(@Ctx() ctx: Context) {
    this.userQuality.set(ctx.chat.id, '720p');
    await ctx.editMessageText('Quality set to 720p');
  }

  @Action('quality_1080')
  async onQuality1080(@Ctx() ctx: Context) {
    this.userQuality.set(ctx.chat.id, '1080p');
    await ctx.editMessageText('Quality set to 1080p');
  }

  // ------------------------------------------------------------------
  // Message handlers
  // ------------------------------------------------------------------

  @On('text')
  async onText(@Ctx() ctx: Context) {
    const text = (ctx.message as any)?.text ?? '';
    const chatId = ctx.chat.id;

    if (text.startsWith('/')) return; // ignore unmatched commands

    if (!this.tiktok.isTiktokLink(text)) {
      await ctx.reply(
        'Please send a TikTok Shop link, or a photo with a caption as your prompt.\n' +
        'Use /quality to set resolution.',
      );
      return;
    }

    const quality = this.userQuality.get(chatId) ?? '720p';
    const jobId = await this.video.queueFromTiktok(text, chatId, quality);

    await ctx.reply(
      `TikTok link received! Scraping product info...\n\n` +
      `Job ID: \`${jobId}\`\n` +
      `Quality: ${quality}\n\n` +
      `I will send the video when ready.`,
      { parse_mode: 'Markdown' },
    );
  }

  @On('photo')
  async onPhoto(@Ctx() ctx: Context) {
    const message = ctx.message as any;
    const chatId = ctx.chat.id;
    const prompt: string = message.caption;

    if (!prompt) {
      await ctx.reply('Please add a caption to your photo — it will be used as the video prompt.');
      return;
    }

    const photos: any[] = message.photo;
    const fileId = photos[photos.length - 1].file_id;
    const fileUrl = await ctx.telegram.getFileLink(fileId);

    const quality = this.userQuality.get(chatId) ?? '720p';
    const jobId = await this.video.queueFromImage(fileUrl.href, prompt, chatId, quality);

    await ctx.reply(
      `Image received!\n` +
      `Prompt: "${prompt}"\n\n` +
      `Job ID: \`${jobId}\`\n` +
      `Quality: ${quality}\n\n` +
      `I will send the video when ready.`,
      { parse_mode: 'Markdown' },
    );
  }

  // ------------------------------------------------------------------
  // Callbacks from VideoService
  // ------------------------------------------------------------------
  private async sendVideo(job: VideoJob) {
    try {
      await this.bot.telegram.sendMessage(job.chatId, 'Your video is ready! Sending now...');

      const isUrl = job.outputPath.startsWith('http://') || job.outputPath.startsWith('https://');

      if (isUrl) {
        await this.bot.telegram.sendVideo(job.chatId, job.outputPath);
      } else {
        await this.bot.telegram.sendVideo(job.chatId, { source: job.outputPath });
      }
    } catch (err) {
      this.logger.error(`Failed to send video for job ${job.id}: ${err.message}`);
      await this.bot.telegram.sendMessage(
        job.chatId,
        `Video generated but could not be sent directly.\nURL: ${job.outputPath}\nError: ${err.message}`,
      );
    }
  }

  private async sendError(job: VideoJob) {
    await this.bot.telegram.sendMessage(
      job.chatId,
      `Video generation failed for job ${job.id}\n\nError: ${job.error}`,
    );
  }
}
