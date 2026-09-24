// Published GR KART specifications (Toyota Gazoo Racing press release, 10 Sep 2026)
// and the derived parameters used by the procedural model and the physics.

export const GR_KART_SPEC = {
  lengthMm: 1820,
  widthMm: 1160,
  heightMm: 670,
  wheelbaseMm: 1045,
  weightKg: 83,
  displacementCc: 215,
  engine: '4-stroke single, air-cooled',
  drive: 'Belt drive with automatic tensioner',
  priceYen: 385000,
  driverHeightCm: [135, 185] as const,
  ballastKg: 15,
  launched: '10 September 2026 (Japan)',
};

/** Model-space dimensions in metres (origin = centre of wheelbase on the ground). */
export const DIM = {
  length: 1.82,
  width: 1.16,
  height: 0.67,
  wheelbase: 1.045,
  frontAxleZ: 1.045 / 2,
  rearAxleZ: -1.045 / 2,
  frontTireR: 0.127, // 10x4.50-5
  frontTireW: 0.114,
  rearTireR: 0.14, // 11x7.10-5
  rearTireW: 0.18,
  rimR: 0.066,
  frontTrackHalf: 0.465,
  rearTrackHalf: 0.49,
};

export interface KartFeature {
  id: string;
  title: string;
  tag: string;
  body: string;
  /** Local-space anchor on the kart for the hotspot. */
  anchor: [number, number, number];
  /** Camera position (local) used when focusing this feature. */
  view: [number, number, number];
  part: string;
}

export const FEATURES: KartFeature[] = [
  {
    id: 'engine',
    title: '215 cc four-stroke',
    tag: 'Powertrain',
    body:
      'A 215 cc single-cylinder four-stroke sits beside the seat. There is no separate battery to charge or carry: the engine charges its own built-in battery, and a primer pump gets fuel to the carb before the first start.',
    anchor: [0.36, 0.42, -0.2],
    view: [1.5, 1.0, -0.6],
    part: 'engine',
  },
  {
    id: 'carb',
    title: 'Diaphragm carburettor',
    tag: 'Fuel system',
    body:
      'A new diaphragm carburettor with no float chamber, so hard cornering doesn’t slosh the fuel level around and upset the mixture. Fuel lines run inside metal to slow ageing.',
    anchor: [0.3, 0.36, -0.04],
    view: [1.3, 0.9, 0.3],
    part: 'engine',
  },
  {
    id: 'belt',
    title: 'Belt drive + auto tensioner',
    tag: 'Drivetrain',
    body:
      'A toothed belt replaces the usual kart chain. An automatic tensioner keeps it tight, so nobody has to adjust or lubricate a chain between sessions.',
    anchor: [0.47, 0.16, -0.42],
    view: [1.35, 0.45, -0.9],
    part: 'belt',
  },
  {
    id: 'pedals',
    title: 'One-touch pedal slide',
    tag: 'Adjustability',
    body:
      'The pedal box slides fore and aft with a single lever. Together with the tilting steering column, one kart fits drivers from 135 cm to 185 cm, so a parent and child can share it.',
    anchor: [0, 0.2, 0.56],
    view: [0.25, 1.3, 1.25],
    part: 'pedals',
  },
  {
    id: 'steering',
    title: 'Tilt steering',
    tag: 'Adjustability',
    body: 'The steering wheel tilts to suit the driver’s height and arm reach. Try the driver-height slider below to see it move.',
    anchor: [0, 0.62, 0.14],
    view: [-0.9, 1.2, 1.1],
    part: 'steering',
  },
  {
    id: 'weightbox',
    title: 'Weight box · 15 kg',
    tag: 'Racing',
    body:
      'An integrated ballast box takes up to 15 kg so lighter drivers can race at a common weight. It also has a mounting point for a lap-timing transponder.',
    anchor: [0.2, 0.14, 0.02],
    view: [1.2, 0.7, 0.8],
    part: 'weightbox',
  },
  {
    id: 'bumper',
    title: 'Anti-climb rear bumper',
    tag: 'Safety',
    body:
      'A full-width rear bumper stops a following kart from riding up over a rear tyre, a common cause of karts getting launched in close racing. Stopper pins on the rear hubs keep the wheels secure.',
    anchor: [0, 0.28, -0.88],
    view: [0.9, 0.9, -1.9],
    part: 'bumper',
  },
  {
    id: 'axle',
    title: 'Stainless rear axle',
    tag: 'Durability',
    body: 'The rear axle shaft is stainless steel, so it won’t rust between track days and needs less maintenance.',
    anchor: [-0.3, 0.14, -0.52],
    view: [-1.2, 0.4, -1.3],
    part: 'axle',
  },
  {
    id: 'seat',
    title: 'Hand-guard seat',
    tag: 'Safety',
    body: 'The seat has a guard that keeps the driver’s hand away from the hot muffler. The throttle cable is also routed so the throttle can’t stick open.',
    anchor: [-0.03, 0.5, -0.46],
    view: [-1.0, 1.4, -0.9],
    part: 'seat',
  },
  {
    id: 'van',
    title: 'Minivan-sized',
    tag: 'Ownership',
    body:
      'At 1,820 × 1,160 mm it fits in the back of a Noah or Voxy minivan without taking it apart. An oil catch tank and a sealed fuel system also let you store it standing on its end. Tap “Stand upright” to see it.',
    anchor: [0.58, 0.3, 0.1],
    view: [2.4, 1.6, 1.8],
    part: 'body',
  },
];
