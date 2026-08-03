import { Module } from '@nestjs/common';
import { ToolsModule } from '../tools/tools.module';
import { NodeService } from './node.service';
import { NodeSecurityService } from './node-security.service';
import { NodeAgentGuard } from './node-agent.guard';
import { TaskHandlerRegistry } from './task-handler.registry';
import {
  HttpNodeTransport,
  LocalNodeTransport,
  NodeTransportRegistry,
  SimulatedNodeTransport,
} from './transport/node-transports';

/**
 * The fleet register and the ways of reaching it.
 *
 * Deliberately free of any dependency on the distributed layer above it: a
 * node exists, reports itself and can be dispatched to, whether or not
 * anything is scheduling work. That direction of dependency is what lets the
 * distributed module import this one without a cycle.
 */
@Module({
  imports: [ToolsModule],
  providers: [
    NodeService,
    NodeSecurityService,
    NodeAgentGuard,
    TaskHandlerRegistry,
    LocalNodeTransport,
    HttpNodeTransport,
    SimulatedNodeTransport,
    NodeTransportRegistry,
  ],
  exports: [
    NodeService,
    NodeSecurityService,
    NodeAgentGuard,
    TaskHandlerRegistry,
    NodeTransportRegistry,
  ],
})
export class NodesModule {}
