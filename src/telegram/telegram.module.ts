import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TelegrafModule } from 'nestjs-telegraf';
import { TelegramUpdate } from './telegram.update';
import { VideoModule } from '../video/video.module';

@Module({
  imports: [
    ConfigModule,
    TelegrafModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        token: config.get('TELEGRAM_BOT_TOKEN'),
      }),
    }),
    VideoModule,
  ],
  providers: [TelegramUpdate],
})
export class TelegramModule {}
