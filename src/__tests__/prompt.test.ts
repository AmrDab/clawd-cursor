import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../core/agent-loop/prompt';

describe('buildSystemPrompt — substrate is the default', () => {
  const p = buildSystemPrompt();
  it('names the substrate tools', () => {
    for (const t of ['compile_ui', 'find_input_field', 'find_action_button', 'element_id', 'snapshot_id']) {
      expect(p).toContain(t);
    }
  });
  it('has a FORM/FIELD workflow rule', () => {
    expect(p).toMatch(/FORM|FIELD/);
    expect(p).toMatch(/find_input_field[\s\S]*set_field_value|set_field_value[\s\S]*element_id/);
  });
  it('describes the UI map (el_NN), not only the legacy a11y snapshot, in the header', () => {
    expect(p).toMatch(/UI map|el_NN|element id/i);
  });
});
