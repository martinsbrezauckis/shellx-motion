import {
  createLocalMotionSandboxCapabilityReceipt,
  probeLocalMotionSandboxCapability,
} from "../packages/core/src/index";

const capability = await probeLocalMotionSandboxCapability();
const receipt = createLocalMotionSandboxCapabilityReceipt(capability);

process.stdout.write(`${JSON.stringify({
  ok: true,
  command: "sandbox:probe",
  capability,
  receipt,
}, null, 2)}\n`);
