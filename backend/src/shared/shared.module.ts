import { Global, Module } from '@nestjs/common';
import { CryptoService } from './crypto/crypto.service';
import { CacheService } from './cache/cache.service';

@Global()
@Module({
  providers: [CryptoService, CacheService],
  exports: [CryptoService, CacheService],
})
export class SharedModule {}
