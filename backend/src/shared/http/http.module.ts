import { Global, Module } from '@nestjs/common';
import { OutboundHttpService } from './outbound-http.service';

/**
 * Outbound HTTP, globally available.
 *
 * Global on purpose. The guard is only useful if it is the path of least
 * resistance — a module that has to be imported before a tenant-supplied URL
 * can be fetched is a module somebody bypasses under deadline. Every module can
 * inject `OutboundHttpService` without wiring, and the architecture test makes
 * the alternative fail the build.
 */
@Global()
@Module({
  providers: [OutboundHttpService],
  exports: [OutboundHttpService],
})
export class HttpEgressModule {}
