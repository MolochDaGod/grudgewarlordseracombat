declare module "yuka" {
  export class Vector3 {
    x: number;
    y: number;
    z: number;
    constructor(x?: number, y?: number, z?: number);
    set(x: number, y: number, z: number): this;
  }
  export class Vehicle {
    position: Vector3;
    velocity: Vector3;
    maxSpeed: number;
    maxForce: number;
    steering: {
      add(behavior: unknown): void;
      remove(behavior: unknown): void;
      clear?: () => void;
      _behaviors?: unknown[];
    };
    update(dt: number): void;
  }
  export class SeekBehavior {
    constructor(target: Vector3);
  }
  export class ArriveBehavior {
    constructor(target: Vector3);
  }
  export class FleeBehavior {
    constructor(target: Vector3);
  }
  export class WanderBehavior {
    wanderRadius: number;
    wanderDistance: number;
  }
}
