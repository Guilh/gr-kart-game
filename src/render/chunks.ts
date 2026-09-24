import * as THREE from 'three';

// Instanced scenery split into square ground cells, so frustum and shadow
// culling can skip whole cells instead of drawing every instance in every pass.

export interface Instance {
  matrix: THREE.Matrix4;
  color?: THREE.Color;
}

/** One InstancedMesh per `cell`-metre XZ cell; geometry and material are shared. */
export function chunkedInstances(geo: THREE.BufferGeometry, mat: THREE.Material | THREE.Material[], items: Instance[], cell: number, name: string) {
  const cells = new Map<string, Instance[]>();
  for (const it of items) {
    const key = `${Math.floor(it.matrix.elements[12] / cell)},${Math.floor(it.matrix.elements[14] / cell)}`;
    let list = cells.get(key);
    if (!list) cells.set(key, (list = []));
    list.push(it);
  }
  const out: THREE.InstancedMesh[] = [];
  for (const list of cells.values()) {
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((it, k) => {
      mesh.setMatrixAt(k, it.matrix);
      if (it.color) mesh.setColorAt(k, it.color);
    });
    mesh.name = name;
    mesh.computeBoundingSphere();
    out.push(mesh);
  }
  return out;
}
