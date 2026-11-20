import { Module } from '@nestjs/common';
import { ScanningController } from './scanning.controller.js';
import { ScanningService } from './scanning.service.js';

@Module({ controllers: [ScanningController], providers: [ScanningService] })
export class ScanningModule {}
