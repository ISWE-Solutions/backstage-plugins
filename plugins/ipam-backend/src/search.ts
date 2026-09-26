import { Readable } from 'node:stream';
import {
  coreServices,
  createBackendModule,
} from '@backstage/backend-plugin-api';
import { searchIndexRegistryExtensionPoint } from '@backstage/plugin-search-backend-node/alpha';
import {
  DocumentCollatorFactory,
  IndexableDocument,
} from '@backstage/plugin-search-common';
import { Raw, sourceFromNote } from '@internal/plugin-ipam-common';
import { createPhpIpamClient, PhpIpamClient } from './phpipamClient';

export const IPAM_DOCUMENT_TYPE = 'ipam-address';

/** Turns every phpIPAM address into a Backstage search document */
export class IpamCollatorFactory implements DocumentCollatorFactory {
  readonly type = IPAM_DOCUMENT_TYPE;

  constructor(private readonly phpipam: PhpIpamClient) {}

  async getCollator() {
    return Readable.from(this.documents());
  }

  async *documents(): AsyncGenerator<IndexableDocument> {
    const subnets = new Map<string, string>();
    const subnetsRaw =
      ((await this.phpipam.request('GET', 'subnets/')).body as any)?.data ?? [];
    for (const s of subnetsRaw as Raw[])
      subnets.set(String(s.id), `${s.subnet}/${s.mask}`);

    const addresses =
      ((await this.phpipam.request('GET', 'addresses/')).body as any)?.data ??
      [];
    for (const a of addresses as Raw[]) {
      const ip = String(a.ip);
      const hostname = a.hostname ? String(a.hostname) : '';
      yield {
        title: hostname ? `${ip} — ${hostname}` : ip,
        text: [
          hostname,
          a.description,
          a.mac ? `MAC ${a.mac}` : '',
          a.owner ? `owner ${a.owner}` : '',
          `subnet ${subnets.get(String(a.subnetId)) ?? a.subnetId}`,
          `source ${sourceFromNote(a.note)}`,
        ]
          .filter(Boolean)
          .join(' · '),
        location: `/ipam?tab=addresses&q=${encodeURIComponent(ip)}`,
      };
    }
  }
}

/** Search backend module: indexes IPAM addresses every 30 minutes */
export default createBackendModule({
  pluginId: 'search',
  moduleId: 'ipam-collator',
  register(env) {
    env.registerInit({
      deps: {
        config: coreServices.rootConfig,
        logger: coreServices.logger,
        scheduler: coreServices.scheduler,
        indexRegistry: searchIndexRegistryExtensionPoint,
      },
      async init({ config, logger, scheduler, indexRegistry }) {
        const url = config.getOptionalString('ipam.phpipam.url');
        const appCode = config.getOptionalString('ipam.phpipam.appCode');
        if (!url || !appCode) {
          logger.info('ipam search collator: phpIPAM not configured, skipping');
          return;
        }
        indexRegistry.addCollator({
          schedule: scheduler.createScheduledTaskRunner({
            frequency: { minutes: 30 },
            timeout: { minutes: 5 },
            initialDelay: { minutes: 3 },
          }),
          factory: new IpamCollatorFactory(
            createPhpIpamClient({
              url,
              appCode,
              verifyTls:
                config.getOptionalBoolean('ipam.phpipam.verifyTls') ?? true,
            }),
          ),
        });
      },
    });
  },
});
