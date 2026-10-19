import { parse } from '@mermaid-js/parser';
import { describe, expect, it } from 'vitest';
import { parseArchitecture, parseTerraform, serializeArchitecture, type Diagram } from '../src';

/** Fixtures follow the providers' documented examples (registry.terraform.io / GitHub docs). */

const load = (tf: string, includeAll = false) =>
  parseTerraform([{ path: 'main.tf', content: tf }], { includeAll });

const byId = (d: Diagram) => Object.fromEntries(d.nodes.map((n) => [n.id, n]));

async function expectValidMermaid(d: Diagram) {
  const text = serializeArchitecture(d);
  let error: string | null = null;
  try {
    await parse('architecture', text);
  } catch (e) {
    error = String((e as Error).message);
  }
  expect(error, text).toBeNull();
  expect(parseArchitecture(text).errors).toEqual([]);
}

const VSPHERE = `
  data "vsphere_datacenter" "datacenter" { name = "dc-01" }
  data "vsphere_datastore" "datastore" {
    name          = "datastore-01"
    datacenter_id = data.vsphere_datacenter.datacenter.id
  }
  data "vsphere_compute_cluster" "cluster" {
    name          = "cluster-01"
    datacenter_id = data.vsphere_datacenter.datacenter.id
  }
  data "vsphere_network" "network" {
    name          = "VM Network"
    datacenter_id = data.vsphere_datacenter.datacenter.id
  }
  data "vsphere_virtual_machine" "template" {
    name          = "ubuntu-template"
    datacenter_id = data.vsphere_datacenter.datacenter.id
  }
  resource "vsphere_virtual_machine" "vm" {
    name             = "foo"
    resource_pool_id = data.vsphere_compute_cluster.cluster.resource_pool_id
    datastore_id     = data.vsphere_datastore.datastore.id
    num_cpus         = 1
    memory           = 1024
    guest_id         = "otherLinux64Guest"
    network_interface {
      network_id = data.vsphere_network.network.id
    }
    disk {
      label = "disk0"
      size  = 20
    }
    clone { template_uuid = data.vsphere_virtual_machine.template.id }
  }
`;

const XEN_ORCHESTRA = `
  data "xenorchestra_pool" "pool" { name_label = "pool-1" }
  data "xenorchestra_template" "template" { name_label = "Ubuntu Bionic Beaver 18.04" }
  data "xenorchestra_network" "net" {
    name_label = "Pool-wide network associated with eth0"
    pool_id    = data.xenorchestra_pool.pool.id
  }
  data "xenorchestra_sr" "local" {
    name_label = "Local storage"
    pool_id    = data.xenorchestra_pool.pool.id
  }
  resource "xenorchestra_cloud_config" "bar" {
    name     = "cloud config name"
    template = "#cloud-config"
  }
  resource "xenorchestra_vm" "bar" {
    memory_max   = 1073733632
    cpus         = 1
    cloud_config = xenorchestra_cloud_config.bar.template
    name_label   = "Name"
    template     = data.xenorchestra_template.template.id
    network {
      network_id = data.xenorchestra_network.net.id
    }
    disk {
      sr_id      = data.xenorchestra_sr.local.id
      name_label = "Ubuntu Bionic Beaver 18.04_imavo"
      size       = 32212254720
    }
  }
`;

const NUTANIX = `
  data "nutanix_cluster" "cluster" { name = "PE-01" }
  resource "nutanix_subnet" "vlan100" {
    cluster_uuid = data.nutanix_cluster.cluster.id
    name         = "vlan100"
    vlan_id      = 100
    subnet_type  = "VLAN"
  }
  resource "nutanix_image" "centos" {
    name       = "centos"
    source_uri = "http://example.com/centos.qcow2"
  }
  resource "nutanix_virtual_machine" "vm1" {
    name                 = "test-dou"
    cluster_uuid         = data.nutanix_cluster.cluster.id
    num_vcpus_per_socket = 1
    num_sockets          = 1
    memory_size_mib      = 186
    nic_list {
      subnet_uuid = nutanix_subnet.vlan100.id
    }
    disk_list {
      data_source_reference = {
        kind = "image"
        uuid = nutanix_image.centos.id
      }
    }
  }
`;

const OVIRT = `
  data "ovirt_blank_template" "blank" {}
  resource "ovirt_vm" "test" {
    name        = "hello_world"
    comment     = "Hello world!"
    cluster_id  = var.cluster_id
    template_id = data.ovirt_blank_template.blank.id
  }
  resource "ovirt_nic" "test" {
    name            = "eth0"
    vm_id           = ovirt_vm.test.id
    vnic_profile_id = var.vnic_profile_id
  }
  resource "ovirt_disk" "data" {
    format           = "raw"
    size             = 1048576
    storage_domain_id = var.storage_domain_id
  }
  resource "ovirt_disk_attachment" "data" {
    vm_id          = ovirt_vm.test.id
    disk_id        = ovirt_disk.data.id
    disk_interface = "virtio_scsi"
  }
`;

const OVIRT_LEGACY = `
  resource "ovirt_network" "app" {
    name          = "app-net"
    datacenter_id = var.datacenter_id
  }
  resource "ovirt_vnic_profile" "app" {
    name       = "app-profile"
    network_id = ovirt_network.app.id
  }
  resource "ovirt_vm" "web" {
    name       = "web"
    cluster_id = var.cluster_id
  }
  resource "ovirt_vnic" "web" {
    name            = "nic1"
    vm_id           = ovirt_vm.web.id
    vnic_profile_id = ovirt_vnic_profile.app.id
  }
`;

const OPENSTACK = `
  data "openstack_networking_network_v2" "public" { name = "public" }
  resource "openstack_networking_network_v2" "app" {
    name           = "app"
    admin_state_up = "true"
  }
  resource "openstack_networking_subnet_v2" "app" {
    name       = "app-subnet"
    network_id = openstack_networking_network_v2.app.id
    cidr       = "192.168.199.0/24"
    ip_version = 4
  }
  resource "openstack_networking_router_v2" "router" {
    name                = "router"
    external_network_id = data.openstack_networking_network_v2.public.id
  }
  resource "openstack_networking_router_interface_v2" "router_app" {
    router_id = openstack_networking_router_v2.router.id
    subnet_id = openstack_networking_subnet_v2.app.id
  }
  resource "openstack_networking_secgroup_v2" "web" { name = "web" }
  resource "openstack_networking_secgroup_rule_v2" "http" {
    direction         = "ingress"
    ethertype         = "IPv4"
    protocol          = "tcp"
    port_range_min    = 80
    port_range_max    = 80
    security_group_id = openstack_networking_secgroup_v2.web.id
  }
  resource "openstack_networking_port_v2" "web" {
    name               = "web-port"
    network_id         = openstack_networking_network_v2.app.id
    security_group_ids = [openstack_networking_secgroup_v2.web.id]
    fixed_ip { subnet_id = openstack_networking_subnet_v2.app.id }
  }
  resource "openstack_compute_instance_v2" "web" {
    name        = "web"
    image_name  = "ubuntu-24.04"
    flavor_name = "m1.small"
    network { port = openstack_networking_port_v2.web.id }
  }
  resource "openstack_compute_instance_v2" "db" {
    name        = "db"
    flavor_name = "m1.large"
    network { uuid = openstack_networking_network_v2.app.id }
  }
  resource "openstack_compute_instance_v2" "bastion" {
    name            = "bastion"
    security_groups = [openstack_networking_secgroup_v2.web.name]
    network { name = "provider-net" }
  }
  resource "openstack_blockstorage_volume_v3" "dbvol" {
    name = "dbvol"
    size = 100
  }
  resource "openstack_compute_volume_attach_v2" "dbvol" {
    instance_id = openstack_compute_instance_v2.db.id
    volume_id   = openstack_blockstorage_volume_v3.dbvol.id
  }
  resource "openstack_lb_loadbalancer_v2" "lb" {
    name          = "lb"
    vip_subnet_id = openstack_networking_subnet_v2.app.id
  }
`;

const LIBVIRT = `
  resource "libvirt_network" "kube" {
    name      = "k8snet"
    mode      = "nat"
    addresses = ["10.17.3.0/24"]
  }
  resource "libvirt_volume" "master" {
    name   = "master.qcow2"
    pool   = "default"
    source = "https://cloud-images.ubuntu.com/noble.img"
  }
  resource "libvirt_cloudinit_disk" "init" {
    name      = "init.iso"
    user_data = "#cloud-config"
  }
  resource "libvirt_domain" "master" {
    name      = "master"
    memory    = "2048"
    vcpu      = 2
    cloudinit = libvirt_cloudinit_disk.init.id
    network_interface {
      network_id = libvirt_network.kube.id
    }
    disk {
      volume_id = libvirt_volume.master.id
    }
  }
  resource "libvirt_domain" "worker" {
    name   = "worker"
    memory = "1024"
    network_interface {
      network_name = "k8snet"
    }
  }
  resource "libvirt_domain" "legacy" {
    name = "legacy"
    network_interface { network_name = "default" }
  }
  resource "libvirt_domain" "modern" {
    name   = "modern"
    type   = "kvm"
    memory = 2048
    devices = {
      interfaces = [
        {
          model  = { type = "virtio" }
          source = { network = { network = "k8snet" } }
        }
      ]
    }
  }
`;

const lxdLike = (p: 'lxd' | 'incus') => `
  resource "${p}_network" "app" {
    name = "appbr0"
    config = {
      "ipv4.address" = "10.150.19.1/24"
      "ipv4.nat"     = "true"
    }
  }
  resource "${p}_storage_pool" "pool1" {
    name   = "mypool"
    driver = "dir"
  }
  resource "${p}_profile" "web" {
    name = "web"
    device {
      name = "eth0"
      type = "nic"
      properties = {
        nictype = "bridged"
        parent  = "\${${p}_network.app.name}"
      }
    }
    device {
      type = "disk"
      name = "root"
      properties = {
        pool = ${p}_storage_pool.pool1.name
        path = "/"
      }
    }
  }
  resource "${p}_instance" "web" {
    name     = "web"
    image    = "images:debian/12"
    profiles = ["default", ${p}_profile.web.name]
  }
  resource "${p}_instance" "api" {
    name     = "api"
    image    = "images:debian/12"
    profiles = ["web"]
  }
  resource "${p}_instance" "db" {
    name  = "db"
    image = "images:ubuntu/24.04"
    type  = "virtual-machine"
    device {
      name = "eth0"
      type = "nic"
      properties = {
        network = "appbr0"
      }
    }
  }
  resource "${p}_instance" "cache" {
    name  = "cache"
    image = "images:alpine/3.20"
    device {
      name = "eth0"
      type = "nic"
      properties = {
        network = "${p}br0"
      }
    }
    device {
      name = "data"
      type = "disk"
      properties = {
        source = "/srv/cache"
        path   = "/data"
      }
    }
  }
`;

const HARVESTER = `
  data "harvester_clusternetwork" "mgmt" { name = "mgmt" }
  resource "harvester_network" "mgmt-vlan1" {
    name                 = "mgmt-vlan1"
    namespace            = "harvester-public"
    vlan_id              = 1
    route_mode           = "auto"
    cluster_network_name = data.harvester_clusternetwork.mgmt.name
  }
  resource "harvester_image" "ubuntu" {
    name         = "ubuntu"
    namespace    = "harvester-public"
    display_name = "ubuntu-24.04"
    source_type  = "download"
    url          = "https://cloud-images.ubuntu.com/noble.img"
  }
  resource "harvester_cloudinit_secret" "init" {
    name      = "init"
    user_data = "#cloud-config"
  }
  resource "harvester_virtualmachine" "web" {
    name      = "web"
    namespace = "default"
    cpu       = 2
    memory    = "2Gi"
    network_interface {
      name         = "nic-1"
      network_name = harvester_network.mgmt-vlan1.id
    }
    disk {
      name       = "rootdisk"
      size       = "10Gi"
      image      = harvester_image.ubuntu.id
    }
    cloudinit { user_data_secret_name = harvester_cloudinit_secret.init.name }
  }
  resource "harvester_virtualmachine" "worker" {
    name = "worker"
    network_interface {
      name         = "nic-1"
      network_name = "harvester-public/mgmt-vlan1"
    }
  }
  resource "harvester_virtualmachine" "edge" {
    name = "edge"
    network_interface {
      name         = "nic-1"
      network_name = "default/edge-vlan"
    }
  }
`;

const RANCHER = `
  resource "rancher2_cloud_credential" "foo" {
    name = "foo"
    amazonec2_credential_config {
      access_key = var.access_key
      secret_key = var.secret_key
    }
  }
  resource "rancher2_machine_config_v2" "foo" {
    generate_name = "test-foo"
    amazonec2_config {
      ami    = "ami-id"
      region = "region"
    }
  }
  resource "rancher2_cluster_v2" "foo" {
    name               = "foo"
    kubernetes_version = "v1.30.4+rke2r1"
    rke_config {
      machine_pools {
        name                         = "pool1"
        cloud_credential_secret_name = rancher2_cloud_credential.foo.id
        control_plane_role           = true
        etcd_role                    = true
        quantity                     = 1
        machine_config {
          kind = rancher2_machine_config_v2.foo.kind
          name = rancher2_machine_config_v2.foo.name
        }
      }
      machine_pools {
        name        = "pool2"
        worker_role = true
        quantity    = 2
        machine_config {
          kind = rancher2_machine_config_v2.foo.kind
          name = rancher2_machine_config_v2.foo.name
        }
      }
    }
  }
  resource "rancher2_app_v2" "monitoring" {
    cluster_id    = rancher2_cluster_v2.foo.cluster_v1_id
    name          = "rancher-monitoring"
    namespace     = "cattle-monitoring-system"
    repo_name     = "rancher-charts"
    chart_name    = "rancher-monitoring"
  }
  resource "rancher2_cluster" "imported" { name = "imported" }
  resource "rancher2_app_v2" "cis" {
    cluster_id = rancher2_cluster.imported.id
    name       = "rancher-cis-benchmark"
    namespace  = "cis-operator-system"
    repo_name  = "rancher-charts"
    chart_name = "rancher-cis-benchmark"
  }
`;

describe('virtualization and private-cloud providers (Terraform)', () => {
  it('vSphere: datacenter > cluster > network > VM; datastore only with includeAll', async () => {
    const d = load(VSPHERE);
    const n = byId(d);
    expect(n.datacenter).toMatchObject({
      kind: 'group',
      label: 'dc-01',
      icon: 'lucide:building-2',
    });
    expect(n.cluster).toMatchObject({ kind: 'group', label: 'cluster-01', parent: 'datacenter' });
    expect(n.network).toMatchObject({ kind: 'group', label: 'VM Network', parent: 'cluster' });
    expect(n.vm).toMatchObject({ kind: 'service', icon: 'server', parent: 'network' });
    // Lookups that aren't infrastructure (templates) and storage are hidden by default.
    expect(n.template).toBeUndefined();
    expect(n.datastore).toBeUndefined();
    expect(d.edges).toEqual([]);
    await expectValidMermaid(d);

    const all = load(VSPHERE, true);
    const a = byId(all);
    expect(a.datastore).toMatchObject({ kind: 'service', icon: 'disk', parent: 'datacenter' });
    expect(all.edges.map((e) => `${e.from}->${e.to}`)).toEqual(['vm->datastore']);
    expect(a.template).toBeUndefined();
    await expectValidMermaid(all);
  });

  it('vSphere: distributed port groups nest in their switch', async () => {
    const d = load(`
      data "vsphere_datacenter" "dc" { name = "dc" }
      resource "vsphere_distributed_virtual_switch" "dvs" {
        name          = "dvs"
        datacenter_id = data.vsphere_datacenter.dc.id
      }
      resource "vsphere_distributed_port_group" "pg" {
        name                            = "pg-app"
        distributed_virtual_switch_uuid = vsphere_distributed_virtual_switch.dvs.id
      }
      resource "vsphere_virtual_machine" "app" {
        network_interface { network_id = vsphere_distributed_port_group.pg.id }
      }
    `);
    const n = byId(d);
    expect(n.dvs).toMatchObject({ kind: 'group', parent: 'dc' });
    expect(n.pg).toMatchObject({ kind: 'group', parent: 'dvs' });
    expect(n.app!.parent).toBe('pg');
    await expectValidMermaid(d);
  });

  it('Xen Orchestra / XCP-ng: pool > network > VM', async () => {
    const d = load(XEN_ORCHESTRA);
    const n = byId(d);
    expect(n.pool).toMatchObject({ kind: 'group', label: 'pool-1', icon: 'lucide:boxes' });
    expect(n.net).toMatchObject({
      kind: 'group',
      parent: 'pool',
      label: 'Pool-wide network associated with eth0',
    });
    expect(n.xenorchestra_vm_bar).toMatchObject({ kind: 'service', icon: 'server', parent: 'net' });
    expect(n.template).toBeUndefined();
    expect(n.local).toBeUndefined();
    expect(byId(load(XEN_ORCHESTRA, true)).local).toMatchObject({ icon: 'disk', parent: 'pool' });
    await expectValidMermaid(d);
  });

  it('Nutanix: cluster > subnet > VM', async () => {
    const d = load(NUTANIX);
    const n = byId(d);
    expect(n.cluster).toMatchObject({ kind: 'group', label: 'PE-01', icon: 'lucide:boxes' });
    expect(n.vlan100).toMatchObject({ kind: 'group', parent: 'cluster' });
    expect(n.vm1).toMatchObject({ kind: 'service', icon: 'server', parent: 'vlan100' });
    expect(d.edges.map((e) => `${e.from}->${e.to}`)).toEqual(['vm1->centos']);
    await expectValidMermaid(d);
  });

  it('Nutanix v4 (_v2 resources) are grouped the same way', () => {
    const n = byId(
      load(`
        data "nutanix_clusters_v2" "clusters" {}
        resource "nutanix_subnet_v2" "app" {
          name             = "app"
          cluster_reference = data.nutanix_clusters_v2.clusters.cluster_entities.0.ext_id
        }
        resource "nutanix_virtual_machine_v2" "vm" {
          name = "vm"
          nics { network_info { subnet { ext_id = nutanix_subnet_v2.app.id } } }
        }
      `),
    );
    expect(n.clusters).toMatchObject({ kind: 'group' });
    expect(n.app).toMatchObject({ kind: 'group', parent: 'clusters' });
    expect(n.vm).toMatchObject({ icon: 'server', parent: 'app' });
  });

  it('oVirt: VMs, NICs hidden, disks linked through attachments', async () => {
    const d = load(OVIRT);
    const n = byId(d);
    expect(n.test).toMatchObject({ kind: 'service', icon: 'server' });
    expect(Object.keys(n).sort()).toEqual(['data', 'test']);
    expect(n.data).toMatchObject({ icon: 'disk' });
    expect(d.edges).toHaveLength(1);
    await expectValidMermaid(d);
  });

  it('oVirt (legacy provider): vNIC + vNIC profile place the VM in its network', async () => {
    const d = load(OVIRT_LEGACY);
    const n = byId(d);
    expect(Object.keys(n).sort()).toEqual(['app', 'web']);
    expect(n.app).toMatchObject({ kind: 'group' });
    expect(n.web).toMatchObject({ icon: 'server', parent: 'app' });
    await expectValidMermaid(d);
  });

  it('OpenStack: ports and named networks place instances, subnets nest in networks', async () => {
    const d = load(OPENSTACK);
    const n = byId(d);
    expect(n.public).toMatchObject({ kind: 'group', label: 'public' });
    expect(n.openstack_networking_network_v2_app).toMatchObject({ kind: 'group' });
    expect(n.openstack_networking_subnet_v2_app).toMatchObject({
      kind: 'group',
      parent: 'openstack_networking_network_v2_app',
    });
    // Through the hidden port, the instance lands in the port's subnet.
    expect(n.openstack_compute_instance_v2_web).toMatchObject({
      icon: 'server',
      parent: 'openstack_networking_subnet_v2_app',
    });
    expect(n.db!.parent).toBe('openstack_networking_network_v2_app');
    expect(n['provider-net']).toMatchObject({ kind: 'group' });
    expect(n.bastion!.parent).toBe('provider-net');
    expect(n.lb).toMatchObject({
      icon: 'lucide:split',
      parent: 'openstack_networking_subnet_v2_app',
    });
    expect(n.router).toMatchObject({ icon: 'lucide:router' });
    expect(n.openstack_networking_secgroup_v2_web).toMatchObject({ icon: 'lucide:shield' });
    expect(n.openstack_networking_secgroup_v2_web!.parent).toBeUndefined();
    expect(n.dbvol).toMatchObject({ icon: 'disk' });
    for (const hidden of ['http', 'router_app', 'openstack_networking_port_v2_web'])
      expect(n[hidden]).toBeUndefined();
    const pairs = d.edges.map((e) => `${e.from}->${e.to}`);
    expect(pairs).toContain('dbvol->db');
    expect(pairs).toContain('bastion->openstack_networking_secgroup_v2_web');
    await expectValidMermaid(d);
  });

  it('libvirt/KVM: networks by id or name (legacy and v0.9 schemas), volumes as disks', async () => {
    const d = load(LIBVIRT);
    const n = byId(d);
    expect(n.kube).toMatchObject({ kind: 'group' });
    expect(n.libvirt_domain_master).toMatchObject({
      kind: 'service',
      icon: 'server',
      parent: 'kube',
    });
    expect(n.worker!.parent).toBe('kube');
    expect(n.modern!.parent).toBe('kube');
    // `default` is not managed by Terraform, so it is synthesized.
    expect(n.default).toMatchObject({ kind: 'group' });
    expect(n.legacy!.parent).toBe('default');
    expect(n.libvirt_volume_master).toMatchObject({ icon: 'disk' });
    expect(n.init).toBeUndefined();
    expect(d.edges.map((e) => `${e.from}->${e.to}`)).toEqual([
      'libvirt_domain_master->libvirt_volume_master',
    ]);
    await expectValidMermaid(d);
  });

  for (const p of ['lxd', 'incus'] as const) {
    it(`${p === 'lxd' ? 'LXD' : 'Incus'}: NIC devices and profiles place instances in networks`, async () => {
      const d = load(lxdLike(p));
      const n = byId(d);
      expect(n.app).toMatchObject({ kind: 'group', icon: 'lucide:network' });
      // Through the profile (referenced, or named in `profiles`).
      expect(n.web).toMatchObject({ kind: 'service', icon: 'lucide:container', parent: 'app' });
      expect(n.api).toMatchObject({ icon: 'lucide:container', parent: 'app' });
      // `properties = { network = "appbr0" }`, and `type = "virtual-machine"` is a VM.
      expect(n.db).toMatchObject({ icon: 'server', parent: 'app' });
      // The default bridge is not managed by Terraform, so it is synthesized.
      expect(n[`${p}br0`]).toMatchObject({ kind: 'group' });
      expect(n.cache!.parent).toBe(`${p}br0`);
      expect(n.pool1).toMatchObject({ icon: 'disk' });
      expect(n.pool1!.parent).toBeUndefined();
      expect(n.web_profile ?? n[`${p}_profile_web`]).toBeUndefined();
      await expectValidMermaid(d);
    });
  }

  it('LXD: only NIC properties count as network names', () => {
    const n = byId(
      load(`
        resource "lxd_instance" "c1" {
          name   = "c1"
          image  = "ubuntu:24.04"
          config = { "user.network" = "x" }
          device {
            name = "data"
            type = "disk"
            properties = { source = "/srv" path = "/srv" }
          }
        }
      `),
    );
    expect(Object.keys(n)).toEqual(['c1']);
  });

  it('Harvester: cluster network > VM network > VM, by reference or "namespace/name"', async () => {
    const d = load(HARVESTER);
    const n = byId(d);
    expect(n.mgmt).toMatchObject({ kind: 'group', label: 'mgmt' });
    expect(n['mgmt-vlan1']).toMatchObject({ kind: 'group', parent: 'mgmt' });
    expect(n.web).toMatchObject({ kind: 'service', icon: 'server', parent: 'mgmt-vlan1' });
    expect(n.worker!.parent).toBe('mgmt-vlan1');
    expect(n['default_edge-vlan']).toMatchObject({
      kind: 'group',
      label: 'default/edge-vlan',
    });
    expect(n.edge!.parent).toBe('default_edge-vlan');
    expect(n.init).toBeUndefined();
    expect(d.edges.map((e) => `${e.from}->${e.to}`)).toEqual(['web->ubuntu']);
    await expectValidMermaid(d);
  });

  it('Rancher: clusters as groups with machine pools and apps inside', async () => {
    const d = load(RANCHER);
    const n = byId(d);
    expect(n.foo).toMatchObject({ kind: 'group', icon: 'lucide:boxes' });
    expect(n.foo_pool1).toMatchObject({ kind: 'service', icon: 'server', parent: 'foo' });
    expect(n.foo_pool2).toMatchObject({ label: 'pool2', parent: 'foo' });
    expect(n.monitoring).toMatchObject({ icon: 'lucide:package', parent: 'foo' });
    expect(n.imported).toMatchObject({ kind: 'group', icon: 'lucide:boxes' });
    expect(n.cis).toMatchObject({ icon: 'lucide:package', parent: 'imported' });
    expect(Object.keys(n).sort()).toEqual(
      ['cis', 'foo', 'foo_pool1', 'foo_pool2', 'imported', 'monitoring'].sort(),
    );
    await expectValidMermaid(d);

    // With includeAll the machine config shows up, linked from the pools.
    const all = load(RANCHER, true);
    const pairs = all.edges.map((e) => `${e.from}->${e.to}`);
    expect(pairs).toContain('foo_pool1->rancher2_machine_config_v2_foo');
    await expectValidMermaid(all);
  });

  it('Proxmox: a node data source stands in for the host group', () => {
    const n = byId(
      load(`
        data "proxmox_virtual_environment_node" "pve1" { node_name = "pve1" }
        resource "proxmox_virtual_environment_vm" "a" { node_name = "pve1" }
        resource "proxmox_virtual_environment_vm" "b" {
          node_name = data.proxmox_virtual_environment_node.pve1.node_name
        }
      `),
    );
    expect(n.pve1).toMatchObject({ kind: 'group', icon: 'lucide:server-cog' });
    expect(n.a!.parent).toBe('pve1');
    expect(n.b!.parent).toBe('pve1');
    expect(Object.keys(n).sort()).toEqual(['a', 'b', 'pve1']);
  });

  it('data sources resolve references without becoming nodes', () => {
    const d = load(`
      data "aws_iam_policy_document" "p" {
        statement { resources = [aws_s3_bucket.a.arn, aws_sqs_queue.q.arn] }
      }
      data "aws_vpc" "main" { default = true }
      resource "aws_s3_bucket" "a" {}
      resource "aws_sqs_queue" "q" {}
      resource "aws_instance" "web" { vpc_security_group_ids = [] subnet_id = data.aws_vpc.main.id }
    `);
    const n = byId(d);
    expect(n.p).toBeUndefined();
    expect(n.main).toMatchObject({ kind: 'group' });
    expect(n.web!.parent).toBe('main');
    // A data source is not a connector: no edge between the bucket and the queue.
    expect(d.edges).toEqual([]);
  });

  it('every provider fixture together is valid Mermaid', async () => {
    const all = [
      VSPHERE,
      XEN_ORCHESTRA,
      NUTANIX,
      OVIRT,
      OVIRT_LEGACY,
      OPENSTACK,
      LIBVIRT,
      lxdLike('lxd'),
      lxdLike('incus'),
      HARVESTER,
      RANCHER,
    ].map((content, i) => ({ path: `f${i}.tf`, content }));
    for (const includeAll of [false, true]) {
      const d = parseTerraform(all, { includeAll });
      expect(new Set(d.nodes.map((n) => n.id)).size).toBe(d.nodes.length);
      await expectValidMermaid(d);
    }
  });
});
