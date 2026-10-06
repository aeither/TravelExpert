import { defineSandbox } from 'eve/sandbox';
import { JustBashSandbox } from 'eve/sandbox/just-bash';

// Default tools are disabled, so the agent never runs commands. just-bash keeps `eve build` working without Docker or a VM on Railway.
export const environment = JustBashSandbox.environment();
export default defineSandbox(() => environment.open());
