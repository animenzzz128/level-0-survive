import * as THREE from 'three';

interface ShellCasing {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  rotVel: THREE.Vector3;
  life: number;
}

export class TacticalWeaponViewmodel {
  public readonly root: THREE.Group;
  private readonly gunPivot: THREE.Group;
  private readonly slideGroup: THREE.Group;
  private readonly flashGroup: THREE.Group;
  private readonly muzzleLight: THREE.PointLight;
  private readonly shellsGroup: THREE.Group;
  private readonly shells: ShellCasing[] = [];
  private readonly casingGeo: THREE.CylinderGeometry;
  private readonly casingMat: THREE.MeshStandardMaterial;

  private recoilZ = 0;
  private recoilPitch = 0;
  private slideBack = 0;
  private flashTimer = 0;
  private reloadTimer = 0;
  private reloadDuration = 1.25;
  private bobPhase = 0;
  private aimFactor = 0;

  private readonly hipPos = new THREE.Vector3(0.22, -0.2, -0.44);
  private readonly adsPos = new THREE.Vector3(0.0, -0.056, -0.29);

  constructor(scene: THREE.Scene, muzzleFlashTex: THREE.CanvasTexture) {
    this.root = new THREE.Group();
    this.gunPivot = new THREE.Group();
    this.gunPivot.position.copy(this.hipPos);
    this.root.add(this.gunPivot);

    this.shellsGroup = new THREE.Group();
    scene.add(this.shellsGroup);
    this.casingGeo = new THREE.CylinderGeometry(0.006, 0.006, 0.022, 6);
    this.casingMat = new THREE.MeshStandardMaterial({
      color: 0xd9a845,
      metalness: 0.85,
      roughness: 0.25,
    });

    const polymerMat = new THREE.MeshStandardMaterial({
      color: 0x1e2022,
      roughness: 0.74,
      metalness: 0.14,
    });
    const steelMat = new THREE.MeshStandardMaterial({
      color: 0x51575e,
      roughness: 0.24,
      metalness: 0.88,
    });
    const darkMetalMat = new THREE.MeshStandardMaterial({
      color: 0x16181a,
      roughness: 0.36,
      metalness: 0.82,
    });
    const gripMat = new THREE.MeshStandardMaterial({
      color: 0x131416,
      roughness: 0.92,
      metalness: 0.05,
    });
    const tritiumMat = new THREE.MeshBasicMaterial({ color: 0x68ffa2 });
    const lensMat = new THREE.MeshStandardMaterial({
      color: 0xfff5d4,
      emissive: new THREE.Color(0xfff1be),
      emissiveIntensity: 1.4,
      roughness: 0.1,
      metalness: 0.1,
    });

    // 1. Contoured polymer lower frame + picatinny under-rail
    const frame = new THREE.Mesh(new THREE.BoxGeometry(0.042, 0.036, 0.26), polymerMat);
    frame.position.set(0, -0.01, -0.02);
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.034, 0.012, 0.12), darkMetalMat);
    rail.position.set(0, -0.028, -0.09);
    this.gunPivot.add(frame, rail);

    // 2. Angled ergonomic grip + stippled side panels + mag floorplate
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.038, 0.135, 0.056), gripMat);
    grip.position.set(0, -0.086, 0.078);
    grip.rotation.x = 0.24;
    const beaverTail = new THREE.Mesh(new THREE.BoxGeometry(0.034, 0.024, 0.04), polymerMat);
    beaverTail.position.set(0, 0.002, 0.102);
    const magBase = new THREE.Mesh(new THREE.BoxGeometry(0.041, 0.02, 0.064), darkMetalMat);
    magBase.position.set(0, -0.153, 0.095);
    magBase.rotation.x = 0.24;
    this.gunPivot.add(grip, beaverTail, magBase);

    // 3. Trigger guard & curved trigger
    const guardBot = new THREE.Mesh(new THREE.BoxGeometry(0.016, 0.008, 0.055), polymerMat);
    guardBot.position.set(0, -0.055, 0.022);
    const guardFront = new THREE.Mesh(new THREE.BoxGeometry(0.016, 0.032, 0.01), polymerMat);
    guardFront.position.set(0, -0.041, -0.004);
    const trigger = new THREE.Mesh(new THREE.BoxGeometry(0.007, 0.022, 0.009), steelMat);
    trigger.position.set(0, -0.038, 0.028);
    trigger.rotation.x = -0.35;
    this.gunPivot.add(guardBot, guardFront, trigger);

    // 4. Beveled brushed-steel upper slide + rear serrations + ejection port
    this.slideGroup = new THREE.Group();
    const slideMain = new THREE.Mesh(new THREE.BoxGeometry(0.046, 0.034, 0.27), steelMat);
    slideMain.position.set(0, 0.022, -0.025);
    const slideCrown = new THREE.Mesh(new THREE.BoxGeometry(0.034, 0.012, 0.268), steelMat);
    slideCrown.position.set(0, 0.043, -0.025);
    this.slideGroup.add(slideMain, slideCrown);

    for (let i = 0; i < 4; i++) {
      const serration = new THREE.Mesh(new THREE.BoxGeometry(0.048, 0.026, 0.005), darkMetalMat);
      serration.position.set(0, 0.022, 0.055 + i * 0.012);
      this.slideGroup.add(serration);
    }

    const port = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.014, 0.054), darkMetalMat);
    port.position.set(0.013, 0.038, -0.01);
    const backplate = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.024, 0.008), darkMetalMat);
    backplate.position.set(0, 0.024, 0.111);
    const hammer = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.012, 8), steelMat);
    hammer.rotation.z = Math.PI / 2;
    hammer.position.set(0, 0.009, 0.114);
    this.slideGroup.add(port, backplate, hammer);

    // 5. Glowing 3-dot tritium iron sights with U-notch base
    const rearBase = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.005, 0.014), darkMetalMat);
    rearBase.position.set(0, 0.049, 0.088);
    const rearSightL = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.012, 0.014), darkMetalMat);
    rearSightL.position.set(-0.012, 0.054, 0.088);
    const rearSightR = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.012, 0.014), darkMetalMat);
    rearSightR.position.set(0.012, 0.054, 0.088);
    const frontPost = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.014, 0.014), darkMetalMat);
    frontPost.position.set(0, 0.054, -0.145);

    const dotL = new THREE.Mesh(new THREE.SphereGeometry(0.0021, 6, 6), tritiumMat);
    dotL.position.set(-0.012, 0.055, 0.096);
    const dotR = new THREE.Mesh(new THREE.SphereGeometry(0.0021, 6, 6), tritiumMat);
    dotR.position.set(0.012, 0.055, 0.096);
    const dotF = new THREE.Mesh(new THREE.SphereGeometry(0.0025, 6, 6), tritiumMat);
    dotF.position.set(0, 0.056, -0.137);
    this.slideGroup.add(rearBase, rearSightL, rearSightR, frontPost, dotL, dotR, dotF);
    this.gunPivot.add(this.slideGroup);

    // 6. Suppressed cylindrical shroud + vented collar + baffle rings
    const suppressor = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.017, 0.145, 16), darkMetalMat);
    suppressor.rotation.x = Math.PI / 2;
    suppressor.position.set(0, 0.02, -0.225);
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.024, 16), steelMat);
    collar.rotation.x = Math.PI / 2;
    collar.position.set(0, 0.02, -0.165);
    this.gunPivot.add(suppressor, collar);
    for (let r = 0; r < 3; r++) {
      const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.0182, 0.0182, 0.006, 16), steelMat);
      ring.rotation.x = Math.PI / 2;
      ring.position.set(0, 0.02, -0.195 - r * 0.036);
      this.gunPivot.add(ring);
    }

    // 7. Underbarrel tactical weapon light + glowing bezel
    const tacLight = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.088, 12), darkMetalMat);
    tacLight.rotation.x = Math.PI / 2;
    tacLight.position.set(0, -0.028, -0.125);
    const tacBezel = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.012, 12), steelMat);
    tacBezel.rotation.x = Math.PI / 2;
    tacBezel.position.set(0, -0.028, -0.168);
    const tacLens = new THREE.Mesh(new THREE.CircleGeometry(0.012, 12), lensMat);
    tacLens.position.set(0, -0.028, -0.175);
    tacLens.rotation.y = Math.PI;
    this.gunPivot.add(tacLight, tacBezel, tacLens);

    // 8. Soft muzzle flash sprite + dynamic point light
    this.flashGroup = new THREE.Group();
    this.flashGroup.position.set(0, 0.02, -0.315);
    this.flashGroup.visible = false;
    const flashMat = new THREE.MeshBasicMaterial({
      map: muzzleFlashTex,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const planeA = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.16), flashMat);
    const planeB = new THREE.Mesh(new THREE.PlaneGeometry(0.18, 0.14), flashMat);
    planeB.rotation.y = Math.PI / 2;
    this.flashGroup.add(planeA, planeB);
    this.gunPivot.add(this.flashGroup);

    this.muzzleLight = new THREE.PointLight(0xffb84d, 0, 8, 2);
    this.muzzleLight.position.set(0, 0.03, -0.34);
    this.gunPivot.add(this.muzzleLight);
  }

  public triggerFire(camera: THREE.Camera): void {
    this.recoilZ = 0.068;
    this.recoilPitch = 0.14;
    this.slideBack = 0.042;
    this.flashTimer = 0.05;
    this.flashGroup.visible = true;
    this.flashGroup.rotation.z = Math.random() * Math.PI * 2;
    const s = 0.72 + Math.random() * 0.35;
    this.flashGroup.scale.set(s, s, 1);
    this.muzzleLight.intensity = 6.5;

    const mesh = new THREE.Mesh(this.casingGeo, this.casingMat);
    const worldStart = new THREE.Vector3(0.18, -0.14, -0.42).applyMatrix4(camera.matrixWorld);
    mesh.position.copy(worldStart);

    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    const vel = right
      .multiplyScalar(1.4 + Math.random() * 0.6)
      .addScaledVector(up, 1.3 + Math.random() * 0.5);

    this.shellsGroup.add(mesh);
    this.shells.push({
      mesh,
      vel,
      rotVel: new THREE.Vector3(Math.random() * 14, Math.random() * 14, Math.random() * 14),
      life: 0.9,
    });
  }

  public triggerReload(duration: number): void {
    this.reloadDuration = duration;
    this.reloadTimer = duration;
  }

  public snapAim(isAiming: boolean): void {
    this.aimFactor = isAiming ? 1 : 0;
    const p = isAiming ? this.adsPos : this.hipPos;
    this.gunPivot.position.copy(p);
    this.gunPivot.rotation.set(0, 0, 0);
  }

  public reset(): void {
    this.recoilZ = 0;
    this.recoilPitch = 0;
    this.slideBack = 0;
    this.slideGroup.position.z = 0;
    this.flashTimer = 0;
    this.flashGroup.visible = false;
    this.muzzleLight.intensity = 0;
    this.reloadTimer = 0;
    this.bobPhase = 0;
    this.snapAim(false);
    for (const s of this.shells) {
      this.shellsGroup.remove(s.mesh);
    }
    this.shells.length = 0;
  }

  public update(
    delta: number,
    isMoving: boolean,
    isSprinting: boolean,
    isAiming: boolean,
    swayX: number,
    swayY: number,
  ): void {
    this.aimFactor = THREE.MathUtils.damp(this.aimFactor, isAiming ? 1 : 0, 14, delta);

    if (this.flashTimer > 0) {
      this.flashTimer -= delta;
      if (this.flashTimer <= 0) {
        this.flashGroup.visible = false;
        this.muzzleLight.intensity = 0;
      }
    }

    this.recoilZ = THREE.MathUtils.damp(this.recoilZ, 0, 16, delta);
    this.recoilPitch = THREE.MathUtils.damp(this.recoilPitch, 0, 15, delta);
    this.slideBack = THREE.MathUtils.damp(this.slideBack, 0, 22, delta);
    this.slideGroup.position.z = this.slideBack;

    if (isMoving) {
      this.bobPhase += delta * (isSprinting ? 13 : 8.5);
    } else {
      this.bobPhase += delta * 1.8;
    }

    const bobAmp = isMoving ? (isSprinting ? 0.012 : 0.0065) * (1 - this.aimFactor * 0.7) : 0.0018;
    const bobX = Math.cos(this.bobPhase * 0.5) * bobAmp;
    const bobY = Math.abs(Math.sin(this.bobPhase)) * bobAmp * 1.1;

    let reloadDipY = 0;
    let reloadRollZ = 0;
    let reloadPitchX = 0;
    if (this.reloadTimer > 0) {
      this.reloadTimer = Math.max(0, this.reloadTimer - delta);
      const t = 1 - this.reloadTimer / this.reloadDuration;
      const curve = Math.sin(t * Math.PI);
      reloadDipY = -curve * 0.14;
      reloadRollZ = curve * 0.52;
      reloadPitchX = -curve * 0.35;
    }

    const baseX = THREE.MathUtils.lerp(this.hipPos.x, this.adsPos.x, this.aimFactor);
    const baseY = THREE.MathUtils.lerp(this.hipPos.y, this.adsPos.y, this.aimFactor);
    const baseZ = THREE.MathUtils.lerp(this.hipPos.z, this.adsPos.z, this.aimFactor);

    this.gunPivot.position.set(
      baseX + bobX + swayX * 0.018,
      baseY - bobY + reloadDipY + swayY * 0.018,
      baseZ + this.recoilZ,
    );
    this.gunPivot.rotation.set(
      this.recoilPitch + reloadPitchX + swayY * 0.12,
      -swayX * 0.15,
      reloadRollZ,
    );

    for (let i = this.shells.length - 1; i >= 0; i--) {
      const s = this.shells[i];
      s.life -= delta;
      s.vel.y -= 9.8 * delta;
      s.mesh.position.addScaledVector(s.vel, delta);
      s.mesh.rotation.x += s.rotVel.x * delta;
      s.mesh.rotation.y += s.rotVel.y * delta;
      if (s.life <= 0 || s.mesh.position.y < 0.03) {
        this.shellsGroup.remove(s.mesh);
        this.shells.splice(i, 1);
      }
    }
  }

  public dispose(): void {
    this.reset();
    this.shellsGroup.parent?.remove(this.shellsGroup);
    const disposables = new Set<{ dispose: () => void }>();
    this.root.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      disposables.add(obj.geometry);
      for (const m of Array.isArray(obj.material) ? obj.material : [obj.material]) {
        disposables.add(m);
      }
    });
    disposables.forEach((d) => d.dispose());
    this.casingGeo.dispose();
    this.casingMat.dispose();
  }
}
