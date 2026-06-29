/*
 * Copyright ©2025 HP Development Company, L.P.
 * Licensed under the X11 License. See LICENSE file in the project root for details.
 */

/**
 * VS Code command identifiers for the ZGX Toolkit extension.
 * These commands can be invoked via the command palette or programmatically.
 */

/**
 * All commands available in the extension.
 * Combines legacy and new commands for easy access.
 */
export const COMMANDS = {
    /** Open the log file in an editor */
    OPEN_LOG: 'zgxToolkit.openLog',
    /** Show the log file location in file explorer */
    SHOW_LOG_LOCATION: 'zgxToolkit.showLogLocation',
    /** Set the log level for the extension */
    SET_LOG_LEVEL: 'zgxToolkit.setLogLevel',
    /** Toggle telemetry on/off */
    TOGGLE_TELEMETRY: 'zgxToolkit.toggleTelemetry',
    /** Show current telemetry status */
    SHOW_TELEMETRY_STATUS: 'zgxToolkit.showTelemetryStatus',
    /** Unpair devices by removing a ConnectX group */
    UNPAIR_DEVICES: 'zgxToolkit.unpairDevices',
    /** Show details of paired devices and their ConnectX NICs */
    PAIR_DETAILS: 'zgxToolkit.pairDetails',
    /** Collect full inventory snapshot from a DGX Spark device */
    RUN_INVENTORY: 'zgxToolkit.runInventory',
    /** Show health posture for a DGX Spark device */
    SHOW_HEALTH: 'zgxToolkit.showHealth',
    /** Run diagnostics (L1 or L2 bundle) on a DGX Spark device */
    RUN_DIAGNOSTICS: 'zgxToolkit.runDiagnostics',
    /** Check for available software/firmware updates on a DGX Spark device */
    CHECK_UPDATES: 'zgxToolkit.checkUpdates',
    /** Open the Device Info panel for a DGX Spark device */
    SHOW_DEVICE_INFO: 'zgxToolkit.showDeviceInfo',
    // Manageability commands (Phase 2)
    RUN_HEALTH_CHECK:          'zgxToolkit.runHealthCheck',
    COLLECT_INVENTORY:         'zgxToolkit.collectDeviceInventory',
    CHECK_FOR_UPDATES:         'zgxToolkit.checkForUpdates',
    CHECK_ANSIBLE_DRIFT:       'zgxToolkit.checkAnsiblePolicyDrift',
    // Internal programmatic command — not shown in command palette
    OPEN_DEVICE_INFO_PANEL:    'zgxToolkit.openDeviceInfoPanel',
    // Tailscale commands (Phase 1)
    ENABLE_TAILSCALE:          'zgxToolkit.enableTailscaleForDevice',
    DISABLE_TAILSCALE:         'zgxToolkit.disableTailscaleForDevice',
    DETECT_TAILSCALE:          'zgxToolkit.detectTailscale',
    // Tailscale API credential commands (Phase 2)
    CONFIGURE_TAILSCALE_API:         'zgxToolkit.configureTailscaleApi',
    CLEAR_TAILSCALE_API_CREDENTIALS: 'zgxToolkit.clearTailscaleApiCredentials',
    // Platform detection
    DETECT_PLATFORM: 'zgxToolkit.detectPlatform',
    // Scheduled checkups (Tier 1)
    RUN_CHECKUP_NOW:             'zgxToolkit.runCheckupNow',
    // eslint-disable-next-line @typescript-eslint/naming-convention
    TOGGLE_SCHEDULED_CHECKUPS:   'zgxToolkit.toggleScheduledCheckups',
    // eslint-disable-next-line @typescript-eslint/naming-convention
    CONFIGURE_SCHEDULED_CHECKUPS: 'zgxToolkit.configureScheduledCheckups',
    // Update review panel (Tier 2) — internal, not shown in palette
    // eslint-disable-next-line @typescript-eslint/naming-convention
    OPEN_UPDATE_REVIEW_PANEL: 'zgxToolkit.openUpdateReviewPanel',
} as const;

/**
 * Type for command identifiers.
 */
export type CommandId = typeof COMMANDS[keyof typeof COMMANDS];