// Sakura Kart Circuit — a fictional ~860 m kart track in the foothills of Mt. Fuji.
// Control points run in race direction (clockwise seen from above, with +z pointing "down"
// on the map). Each entry: [x, z, width, runoffLeft, runoffRight] — base run-off
// widths; extra run-off is added automatically on the outside of corners.

export type ControlPoint = [number, number, number, number, number];

export const SAKURA_CIRCUIT: { name: string; points: ControlPoint[]; startIndex: number } = {
  name: 'Sakura Kart Circuit',
  startIndex: 0,
  points: [
    // Main straight, heading west — start/finish at the first point
    [20, 80, 11, 7, 6],
    [-30, 80, 11, 7, 6],
    [-68, 79.5, 10.5, 7, 6],
    // T1 "Ichi" — right-hander onto the western esses
    [-94, 72, 10, 5, 5],
    [-107, 55, 9.5, 5, 5],
    // Western esses, climbing
    [-110, 32, 9, 5, 5],
    [-104, 11, 9, 5, 5],
    [-111, -12, 9, 5, 5],
    [-106, -35, 9, 5, 5],
    [-107, -55, 9, 5, 5],
    // T4 "Sakura" — long sweeping right onto the back straight
    [-99, -75, 9.5, 5, 5],
    [-81, -88, 9.5, 5, 5],
    [-58, -92.5, 10, 5, 5],
    // Back straight, over the crest and under the bridge
    [-10, -93, 10, 5, 5],
    [40, -90, 10, 5, 5],
    [84, -92, 10, 5, 5],
    // Hairpin "Fuji" — tight right, 180°
    [104, -90, 10.5, 5, 5],
    [118, -84.5, 10.5, 5, 5],
    [123, -72, 10.5, 5, 5],
    [116, -60.5, 10.5, 5, 5],
    [100, -57.5, 10, 5, 5],
    // Short run west
    [80, -57.5, 9, 5, 5],
    // T7 — left, dropping into the infield
    [62, -52, 9, 5, 5],
    [54, -38, 9, 5, 5],
    [53, -15, 9, 5, 5],
    [51, 0, 9, 5, 5],
    // T8 — left, flicking east
    [57, 14, 9, 5, 5],
    [72, 21.5, 9, 5, 5],
    [100, 22, 9.5, 5, 5],
    // T9 "Carousel" — long right-hander back onto the main straight
    [122, 25, 10, 5, 5],
    [142, 33, 10, 5, 5],
    [152, 51, 10, 5, 5],
    [145, 70, 10.5, 5, 5],
    [125, 79.5, 11, 7, 6],
    [80, 80.5, 11, 7, 6],
  ],
};
