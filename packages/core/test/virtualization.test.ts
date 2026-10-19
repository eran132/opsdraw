import { describe, expect, it } from 'vitest';
import { importIac, parseArchitecture, parseTerraform, serializeArchitecture } from '../src';

const byId = (tf: string) =>
  Object.fromEntries(
    parseTerraform([{ path: 'main.tf', content: tf }]).nodes.map((n) => [n.id, n]),
  );

describe('on-prem virtualization (Terraform)', () => {
  it('Proxmox (bpg): hosts, managed bridges, unmanaged bridges per host, LXC', () => {
    const tf = `
      resource "proxmox_virtual_environment_network_linux_bridge" "lan" {
        node_name = "pve1"
        name      = "vmbr1"
      }
      resource "proxmox_virtual_environment_vm" "web" {
        node_name = "pve1"
        network_device { bridge = "vmbr1" }
      }
      resource "proxmox_virtual_environment_vm" "db" {
        node_name = "pve2"
        network_device { bridge = "vmbr0" }
      }
      resource "proxmox_virtual_environment_container" "cache" {
        node_name = "pve2"
        network_interface { name = "eth0" bridge = "vmbr0" }
      }
      resource "proxmox_virtual_environment_download_file" "img" { node_name = "pve1" }
    `;
    const n = byId(tf);
    expect(n.pve1).toMatchObject({ kind: 'group', icon: 'lucide:server-cog' });
    expect(n.lan).toMatchObject({ kind: 'group', parent: 'pve1' });
    expect(n.web).toMatchObject({ kind: 'service', icon: 'server', parent: 'lan' });
    // vmbr0 is not managed by Terraform, so it is synthesized inside pve2.
    expect(n.vmbr0).toMatchObject({ kind: 'group', parent: 'pve2' });
    expect(n.db!.parent).toBe('vmbr0');
    expect(n.cache).toMatchObject({ icon: 'lucide:container', parent: 'vmbr0' });
    expect(n.img).toBeUndefined();
  });

  it('Proxmox (Telmate): target_node and LXC', () => {
    const n = byId(`
      resource "proxmox_vm_qemu" "k8s" { target_node = "node-a" network { bridge = "vmbr0" } }
      resource "proxmox_lxc" "dns" { target_node = "node-a" network { bridge = "vmbr0" } }
    `);
    expect(n.node_a ?? n['node-a']).toMatchObject({ kind: 'group' });
    expect(n.k8s).toMatchObject({ icon: 'server', parent: 'vmbr0' });
    expect(n.dns).toMatchObject({ icon: 'lucide:container', parent: 'vmbr0' });
  });

  it('VergeOS: NICs place VMs inside networks, drives become disks', () => {
    const n = byId(`
      resource "vergeio_network" "internal" { name = "internal" }
      resource "vergeio_vm" "app" { name = "app" }
      resource "vergeio_nic" "app_nic" {
        machine = vergeio_vm.app.machine
        vnet    = vergeio_network.internal.id
      }
      resource "vergeio_drive" "app_disk" { machine = vergeio_vm.app.machine }
    `);
    expect(n.internal).toMatchObject({ kind: 'group' });
    expect(n.app).toMatchObject({ icon: 'server', parent: 'internal' });
    expect(n.app_nic).toBeUndefined();
    expect(n.app_disk).toMatchObject({ icon: 'disk' });
  });

  it('Hyper-V: switches and VHDs', () => {
    const n = byId(`
      resource "hyperv_network_switch" "dmz" { name = "DMZ" }
      resource "hyperv_vhd" "web_vhd" { path = "C:/vms/web.vhdx" }
      resource "hyperv_machine_instance" "web" {
        network_adaptors { switch_name = "DMZ" }
        hard_disk_drives { path = hyperv_vhd.web_vhd.path }
      }
    `);
    expect(n.dmz).toMatchObject({ kind: 'group' });
    expect(n.web).toMatchObject({ icon: 'server', parent: 'dmz' });
    expect(n.web_vhd).toMatchObject({ icon: 'disk' });
  });

  it('VirtualBox: host-only networks are synthesized', () => {
    const n = byId(`
      resource "virtualbox_vm" "node" {
        network_adapter { type = "hostonly" host_interface = "vboxnet0" }
      }
    `);
    expect(n.vboxnet0).toMatchObject({ kind: 'group' });
    expect(n.node).toMatchObject({ icon: 'server', parent: 'vboxnet0' });
  });

  it('produces valid Mermaid through importIac', () => {
    const { diagram, kinds } = importIac([
      {
        path: 'pve.tf',
        content:
          'resource "proxmox_vm_qemu" "a" { target_node = "pve" network { bridge = "vmbr0" } }',
      },
    ]);
    expect(kinds).toEqual(['terraform']);
    expect(parseArchitecture(serializeArchitecture(diagram)).errors).toEqual([]);
  });
});
