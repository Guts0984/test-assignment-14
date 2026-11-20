import { Module } from '@nestjs/common';
import { EventsController, OrganizerEventsController } from './events.controller.js';
import { EventsService } from './events.service.js';

@Module({ controllers: [EventsController, OrganizerEventsController], providers: [EventsService], exports: [EventsService] })
export class EventsModule {}
