import { Track } from '../src/track/track';
import { SAKURA_CIRCUIT } from '../src/track/trackData';
import { computeRacingLine } from '../src/track/racingLine';
const track = new Track(SAKURA_CIRCUIT.name, SAKURA_CIRCUIT.points);
const line = computeRacingLine(track);
for (let s = 0; s < track.length; s += 20) {
  const i = track.indexAt(s);
  console.log(`s=${s.toFixed(0).padStart(4)} x=${track.px[i].toFixed(0).padStart(5)} z=${track.pz[i].toFixed(0).padStart(5)} y=${track.py[i].toFixed(2).padStart(6)} hw=${track.hw[i].toFixed(1)} k=${(track.curv[i]*100).toFixed(2).padStart(6)} R=${(1/Math.abs(track.curv[i]+1e-9)).toFixed(0).padStart(6)} off=${line.offset[i].toFixed(2).padStart(6)} v=${line.speed[i].toFixed(1).padStart(5)} wallL=${track.wallL[i].toFixed(1)} wallR=${track.wallR[i].toFixed(1)} kL=${track.kerbL[i]>0?1:0} kR=${track.kerbR[i]>0?1:0}`);
}
