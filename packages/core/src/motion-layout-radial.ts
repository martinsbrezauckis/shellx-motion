/**
 * Deterministic radial unit-circle evaluation for the layout ABI.
 *
 * Layout fingerprints and emitted coordinates must not depend on a host's libm implementation.
 * Angles are first canonicalized to 10^-24 degrees, then evaluated by a fixed 48-step integer
 * CORDIC using literal ABI constants. The final Number conversion is only for the bounded layout
 * arithmetic; coordinates are quantized by the caller before they leave Core.
 */

const ANGLE_DECIMALS = 24;
const ANGLE_SCALE = 1_000_000_000_000_000_000_000_000n;
const VECTOR_SCALE = 1_000_000_000_000_000_000_000_000n;
const QUARTER_TURN = 90n * ANGLE_SCALE;
const HALF_TURN = 180n * ANGLE_SCALE;
const FULL_TURN = 360n * ANGLE_SCALE;

// 1 / CORDIC gain at VECTOR_SCALE. These values are intentionally literal rather than derived
// from Math.* at runtime, so every supported JavaScript host takes the same integer path.
const CORDIC_GAIN_INVERSE = 607_252_935_008_881_240_702_976n;
const CORDIC_ANGLE_STEPS: readonly bigint[] = [
  45_000_000_000_000_000_000_000_000n,
  26_565_051_177_077_988_162_273_280n,
  14_036_243_467_926_477_754_859_520n,
  7_125_016_348_901_797_921_816_576n,
  3_576_334_374_997_351_376_879_616n,
  1_789_910_608_246_069_396_504_576n,
  895_173_710_211_074_314_207_232n,
  447_614_170_860_553_018_277_888n,
  223_810_500_368_538_066_223_104n,
  111_905_677_066_206_890_164_224n,
  55_952_891_893_803_663_753_216n,
  27_976_452_617_003_675_418_624n,
  13_988_227_142_265_016_942_592n,
  6_994_113_675_352_918_196_224n,
  3_497_056_850_704_011_362_304n,
  1_748_528_426_980_449_452_032n,
  874_264_213_693_780_197_376n,
  437_132_106_872_334_581_760n,
  218_566_053_439_347_851_264n,
  109_283_026_720_071_499_776n,
  54_641_513_360_085_442_560n,
  27_320_756_680_048_934_912n,
  13_660_377_833_002_541_600n,
  6_830_189_170_012_719_104n,
  3_415_094_585_006_371_328n,
  1_707_547_585_002_931_872n,
  853_773_646_251_593_728n,
  426_886_823_125_796_928n,
  213_443_411_562_898_464n,
  106_721_705_781_449_232n,
  53_360_852_890_724_616n,
  26_680_426_445_362_308n,
  13_340_213_222_681_154n,
  6_670_106_611_340_577n,
  3_335_053_305_670_289n,
  1_667_526_657_521_445n,
  833_763_326_417_572n,
  416_881_663_208_786n,
  208_440_831_604_393n,
  104_220_415_802_197n,
  52_110_207_901_098n,
  26_055_103_901_049n,
  13_027_551_975_275n,
  6_513_775_987_637n,
  3_256_887_993_819n,
  1_628_443_996_909n,
  814_221_998_455n,
  407_110_999_227n,
];

export function fixedRadialDegrees(value: number): bigint {
  const text = value.toFixed(ANGLE_DECIMALS);
  const negative = text.startsWith("-");
  const [whole, fraction] = (negative ? text.slice(1) : text).split(".");
  const magnitude = BigInt(whole) * ANGLE_SCALE + BigInt(fraction);
  return negative ? -magnitude : magnitude;
}

/** Returns a fixed-path sin/cos pair for an angle in canonical fixed degrees. */
export function deterministicRadialUnitCircle(angleDegrees: bigint): { cos: number; sin: number } {
  const angle = positiveModulo(angleDegrees, FULL_TURN);
  if (angle === 0n) return { cos: 1, sin: 0 };
  if (angle === QUARTER_TURN) return { cos: 0, sin: 1 };
  if (angle === HALF_TURN) return { cos: -1, sin: 0 };
  if (angle === QUARTER_TURN * 3n) return { cos: 0, sin: -1 };

  let local = angle;
  let cosSign = 1n;
  let sinSign = 1n;
  if (angle > QUARTER_TURN && angle < HALF_TURN) {
    local = HALF_TURN - angle;
    cosSign = -1n;
  } else if (angle > HALF_TURN && angle < QUARTER_TURN * 3n) {
    local = angle - HALF_TURN;
    cosSign = -1n;
    sinSign = -1n;
  } else if (angle > QUARTER_TURN * 3n) {
    local = FULL_TURN - angle;
    sinSign = -1n;
  }

  let x = CORDIC_GAIN_INVERSE;
  let y = 0n;
  let remaining = local;
  for (let index = 0; index < CORDIC_ANGLE_STEPS.length; index += 1) {
    const divisor = 1n << BigInt(index);
    const stepX = x / divisor;
    const stepY = y / divisor;
    if (remaining >= 0n) {
      [x, y, remaining] = [x - stepY, y + stepX, remaining - CORDIC_ANGLE_STEPS[index]];
    } else {
      [x, y, remaining] = [x + stepY, y - stepX, remaining + CORDIC_ANGLE_STEPS[index]];
    }
  }
  return { cos: Number(cosSign * x) / Number(VECTOR_SCALE), sin: Number(sinSign * y) / Number(VECTOR_SCALE) };
}

export function fixedRadialFraction(value: bigint, numerator: number, denominator: number): bigint {
  return value * BigInt(numerator) / BigInt(denominator);
}

function positiveModulo(value: bigint, modulus: bigint): bigint {
  const remainder = value % modulus;
  return remainder < 0n ? remainder + modulus : remainder;
}
