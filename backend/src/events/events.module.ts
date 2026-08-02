import { Global, Module } from '@nestjs/common';
import { EventBusService } from './event-bus.service';
import { EventsController } from './events.controller';

/**
 * Global: nearly every feature module publishes events, and requiring each of
 * them to import EventsModule adds noise without adding safety.
 */
@Global()
@Module({
  controllers: [EventsController],
  providers: [EventBusService],
  exports: [EventBusService],
})
export class EventsModule {}
