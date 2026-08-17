declare module "grudge-studio/tools" {
  // The grudge-studio SDK ships untyped. We only declare the surface we use.
  export class ThirdPersonCameraController {
    constructor(camera: any, target: any, options?: any);
    enabled: boolean;
    cameraOffset: any;
    dynamicOffset: any;
    minDistance: number;
    update(deltaTime: number, inputManager?: any): void;
    setOffset(offset: any): void;
    setCollisionObjects(objects: any[]): void;
    shake(intensity?: number, duration?: number): void;
  }

  export class AdvancedLightingSystem {
    constructor(scene: any, options?: any);
    lights: Map<string, any>;
    createPointLight(
      position: any,
      color?: number,
      intensity?: number,
      distance?: number,
    ): { id: string; light: any };
  }

  export const Helpers: {
    createCharacter: (scene: any, position: any, options?: any) => any;
  };

  const _default: any;
  export default _default;
}
