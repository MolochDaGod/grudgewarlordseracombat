import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { bakeKit } from "./kitBake";

function bone(name: string, y: number, parent?: THREE.Object3D): THREE.Bone {
  const b = new THREE.Bone();
  b.name = name;
  b.position.y = y;
  parent?.add(b);
  return b;
}

describe("bakeKit", () => {
  it("records Bip001 names and SI height from bone span", () => {
    const root = new THREE.Group();
    const hips = bone("Bip001 Pelvis", 0.95, root);
    bone("Bip001 Head", 0.75, hips);
    bone("Bip001 R Hand", 0.4, hips);
    bone("Bip001 L Foot", -0.95, hips);
    bone("Bip001 R Foot", -0.95, hips);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.4, 1.8, 0.3));
    mesh.name = "WK_body_A";
    root.add(mesh);
    root.updateMatrixWorld(true);

    const bake = bakeKit(root, "bip001");
    expect(bake.hips).toBe("Bip001 Pelvis");
    expect(bake.head).toBe("Bip001 Head");
    expect(bake.handR).toBe("Bip001 R Hand");
    expect(bake.footL).toBe("Bip001 L Foot");
    expect(bake.meshes).toContain("WK_body_A");
    expect(bake.heightM).toBeGreaterThan(1.4);
  });

  it("accepts mixamorig aliases without colon", () => {
    const root = new THREE.Group();
    bone("mixamorigHips", 1, root);
    bone("mixamorigRightHand", 1.4, root);
    bone("mixamorigLeftFoot", 0, root);
    const bake = bakeKit(root, "mixamo");
    expect(bake.hips).toBe("mixamorigHips");
    expect(bake.handR).toBe("mixamorigRightHand");
    expect(bake.footL).toBe("mixamorigLeftFoot");
  });
});
