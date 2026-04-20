import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TelegramModule } from './telegram/telegram.module';
import { TiktokModule } from './tiktok/tiktok.module';
import { QueueModule } from './queue/queue.module';
import { VideoModule } from './video/video.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TelegramModule,
    TiktokModule,
    QueueModule,
    VideoModule,
  ],
})
export class AppModule {}
