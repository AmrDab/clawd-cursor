/**
 * Readiness — single source of truth for Clawd Cursor operational status.
 * 
 * Consolidates:
 * - Consent status
 * - macOS permissions (Accessibility, Screen Recording)
 * - AI provider configuration
 * - Overall readiness for desktop control
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { hasConsent } from './onboarding';
import { checkPermissionsQuick, isMacOS } from './native-helper';

const CONFIG_FILE = '.clawdcursor-config.json';

export interface ReadinessStatus {
  // Core requirements
  consent: {
    granted: boolean;
    file: string;
  };
  
  // macOS-specific permissions (null on other platforms)
  macPermissions: {
    accessibility: boolean;
    screenRecording: boolean;
  } | null;
  
  // AI configuration
  aiConfig: {
    configured: boolean;
    configFile: string;
    hasTextModel: boolean;
    hasVisionModel: boolean;
  };
  
  // Overall status
  ready: boolean;
  readyForDesktopControl: boolean;
  
  // Human-readable summary
  issues: string[];
  nextSteps: string[];
}

/**
 * Check if AI config exists and has models configured
 */
function checkAiConfig(): { configured: boolean; hasTextModel: boolean; hasVisionModel: boolean } {
  const configPath = path.join(process.cwd(), CONFIG_FILE);
  
  if (!fs.existsSync(configPath)) {
    return { configured: false, hasTextModel: false, hasVisionModel: false };
  }
  
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const hasTextModel = !!(config.pipeline?.textModel || config.textModel);
    const hasVisionModel = !!(config.pipeline?.visionModel || config.visionModel);
    return { configured: true, hasTextModel, hasVisionModel };
  } catch {
    return { configured: false, hasTextModel: false, hasVisionModel: false };
  }
}

/**
 * Get full readiness status — the single source of truth.
 */
export async function getReadinessStatus(): Promise<ReadinessStatus> {
  const consentDir = path.join(os.homedir(), '.clawdcursor');
  const consentFile = path.join(consentDir, 'consent');
  const configFile = path.join(process.cwd(), CONFIG_FILE);
  
  // Check consent
  const consentGranted = hasConsent();
  
  // Check macOS permissions (only on macOS)
  let macPermissions: ReadinessStatus['macPermissions'] = null;
  if (isMacOS()) {
    try {
      const perms = await checkPermissionsQuick();
      macPermissions = {
        accessibility: perms.accessibility,
        screenRecording: perms.screenRecording,
      };
    } catch {
      // If native helper isn't built yet, assume unknown
      macPermissions = {
        accessibility: false,
        screenRecording: false,
      };
    }
  }
  
  // Check AI config
  const aiConfig = checkAiConfig();
  
  // Determine issues and next steps
  const issues: string[] = [];
  const nextSteps: string[] = [];
  
  if (!consentGranted) {
    issues.push('Desktop control consent not granted');
    nextSteps.push('Run: clawdcursor consent');
  }
  
  if (isMacOS() && macPermissions) {
    if (!macPermissions.accessibility) {
      issues.push('macOS Accessibility permission not granted');
      nextSteps.push('System Settings → Privacy & Security → Accessibility → Enable ClawdCursor');
    }
    if (!macPermissions.screenRecording) {
      issues.push('macOS Screen Recording permission not granted');
      nextSteps.push('System Settings → Privacy & Security → Screen & System Audio Recording → Enable ClawdCursor');
    }
  }
  
  if (!aiConfig.configured) {
    issues.push('AI provider not configured');
    nextSteps.push('Run: clawdcursor doctor');
  } else if (!aiConfig.hasTextModel && !aiConfig.hasVisionModel) {
    issues.push('No AI models configured');
    nextSteps.push('Run: clawdcursor doctor');
  }
  
  // Determine overall readiness
  const hasRequiredPermissions = !isMacOS() || (macPermissions?.accessibility ?? false);
  const readyForDesktopControl = consentGranted && hasRequiredPermissions;
  const ready = readyForDesktopControl && aiConfig.configured;
  
  return {
    consent: {
      granted: consentGranted,
      file: consentFile,
    },
    macPermissions,
    aiConfig: {
      ...aiConfig,
      configFile,
    },
    ready,
    readyForDesktopControl,
    issues,
    nextSteps,
  };
}

/**
 * Print a formatted status report to console.
 */
export async function printStatusReport(): Promise<void> {
  const status = await getReadinessStatus();
  
  const G = '\x1b[32m';  // Green
  const R = '\x1b[31m';  // Red
  const Y = '\x1b[33m';  // Yellow
  const B = '\x1b[1m';   // Bold
  const D = '\x1b[90m';  // Dim
  const X = '\x1b[0m';   // Reset
  
  const check = (ok: boolean) => ok ? `${G}✓${X}` : `${R}✗${X}`;
  const warn = (ok: boolean) => ok ? `${G}✓${X}` : `${Y}⚠${X}`;
  
  console.log(`\n${B}🐾 Clawd Cursor Status${X}\n`);
  console.log(`${D}${'─'.repeat(50)}${X}`);
  
  // Consent
  console.log(`${check(status.consent.granted)} Consent: ${status.consent.granted ? 'Granted' : 'Not granted'}`);
  
  // macOS Permissions
  if (status.macPermissions) {
    console.log(`${check(status.macPermissions.accessibility)} Accessibility: ${status.macPermissions.accessibility ? 'Granted' : 'Not granted'}`);
    console.log(`${warn(status.macPermissions.screenRecording)} Screen Recording: ${status.macPermissions.screenRecording ? 'Granted' : 'Not granted'} ${!status.macPermissions.screenRecording ? D + '(optional)' + X : ''}`);
  } else if (process.platform !== 'darwin') {
    console.log(`${G}✓${X} Platform: ${process.platform} ${D}(no special permissions needed)${X}`);
  }
  
  // AI Config
  console.log(`${check(status.aiConfig.configured)} AI Config: ${status.aiConfig.configured ? 'Found' : 'Not configured'}`);
  if (status.aiConfig.configured) {
    console.log(`  ${check(status.aiConfig.hasTextModel)} Text model: ${status.aiConfig.hasTextModel ? 'Configured' : 'Not set'}`);
    console.log(`  ${warn(status.aiConfig.hasVisionModel)} Vision model: ${status.aiConfig.hasVisionModel ? 'Configured' : 'Not set'} ${!status.aiConfig.hasVisionModel ? D + '(optional)' + X : ''}`);
  }
  
  console.log(`${D}${'─'.repeat(50)}${X}`);
  
  // Overall Status
  if (status.ready) {
    console.log(`\n${G}${B}✓ Ready for desktop control${X}\n`);
  } else if (status.readyForDesktopControl) {
    console.log(`\n${Y}${B}⚠ Desktop control ready, but AI not configured${X}`);
    console.log(`  Layer 1 (Action Router) will work without AI.\n`);
  } else {
    console.log(`\n${R}${B}✗ Not ready for desktop control${X}\n`);
  }
  
  // Next Steps
  if (status.nextSteps.length > 0) {
    console.log(`${B}Next steps:${X}`);
    status.nextSteps.forEach((step, i) => {
      console.log(`  ${i + 1}. ${step}`);
    });
    console.log('');
  }
}

/**
 * Quick check if basic requirements are met (for gating commands).
 */
export async function isReadyForDesktopControl(): Promise<boolean> {
  const status = await getReadinessStatus();
  return status.readyForDesktopControl;
}

/**
 * Get a one-line summary suitable for doctor output.
 */
export async function getReadinessSummary(): Promise<string> {
  const status = await getReadinessStatus();
  
  if (status.ready) {
    return '✓ All systems ready';
  } else if (status.readyForDesktopControl) {
    return '⚠ Desktop ready, AI not configured';
  } else {
    return `✗ ${status.issues.length} issue(s): ${status.issues.slice(0, 2).join(', ')}`;
  }
}
