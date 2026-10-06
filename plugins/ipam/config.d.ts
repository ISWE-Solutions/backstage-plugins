export interface Config {
  ipam?: {
    /**
     * phpIPAM section that subnets added from the IPAM page go into
     * (default: the first section)
     * @visibility frontend
     */
    subnetSection?: string;
  };
}
