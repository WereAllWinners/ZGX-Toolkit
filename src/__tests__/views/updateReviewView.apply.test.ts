/*
 * Copyright © 2026 Jerome Gabryszewski
 * Licensed under the X11 License. See LICENSE file in the project root for details.
 */

/**
 * Unit tests for Task 03: UpdateReviewViewController.applySelected() —
 * the real apply handler that replaces the Task 02 stub.
 */

import { UpdateReviewViewController } from '../../views/devices/updates/updateReviewViewController';
import { Logger } from '../../utils/logger';
import { ITelemetryService } from '../../types/telemetry';
import { DeviceService } from '../../services/deviceService';
import { Device } from '../../types/devices';
import { ApplyPlan, ApplyResult, PendingUpdatesState } from '../../types/scheduledUpdates';

jest.mock('vscode');

jest.mock('../../services/updateReconciliationService', () => ({
    updateReconciliationService: {
        buildApplyPlan: jest.fn(),
        executeApplyPlan: jest.fn(),
    },
}));

jest.mock('../../utils/logger', () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        trace: jest.fn(),
    },
}));

import { updateReconciliationService } from '../../services/updateReconciliationService';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeDevice(metadata: Record<string, any> = {}): Device {
    const pending: PendingUpdatesState = {
        computedAt: new Date().toISOString(),
        source: 'apt',
        candidates: [
            { package: 'curl', currentVersion: '7.0', availableVersion: '8.0', source: 'apt' },
        ],
        ansibleExclusions: [],
        kernelExclusions: [],
        status: 'available',
    };
    return {
        id: 'dev-001',
        name: 'zgx-nano',
        host: '10.0.0.1',
        username: 'nvidia',
        port: 22,
        isSetup: true,
        useKeyAuth: true,
        keySetup: { keyGenerated: true, keyCopied: true, connectionTested: true },
        createdAt: '2026-06-28T00:00:00Z',
        metadata: { pendingUpdates: pending, ...metadata },
    } as Device;
}

function makePlan(overrides: Partial<ApplyPlan> = {}): ApplyPlan {
    return {
        provider: 'apt',
        toApply: ['curl'],
        skipped: [],
        additionalChanges: [],
        dgxControllerAbsent: false,
        ...overrides,
    };
}

function makeSuccessResult(overrides: Partial<ApplyResult> = {}): ApplyResult {
    return {
        provider: 'apt',
        applied: ['curl'],
        skipped: [],
        success: true,
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

function makeDeps() {
    const mockLogger: jest.Mocked<Logger> = {
        debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), trace: jest.fn(),
    } as any;

    const mockTelemetry: jest.Mocked<ITelemetryService> = {
        trackEvent: jest.fn(), trackError: jest.fn(),
        isEnabled: jest.fn().mockReturnValue(false),
        setEnabled: jest.fn(),
        dispose: jest.fn().mockResolvedValue(undefined),
    } as any;

    const mockDeviceService: jest.Mocked<DeviceService> = {
        getDevice: jest.fn().mockResolvedValue(makeDevice()),
        getAllDevices: jest.fn().mockResolvedValue([]),
        createDevice: jest.fn(),
        updateDevice: jest.fn(),
        deleteDevice: jest.fn(),
        subscribe: jest.fn().mockReturnValue(() => {}),
    } as any;

    return { mockLogger, mockTelemetry, mockDeviceService };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UpdateReviewViewController — Task 03 apply handler', () => {
    let view: UpdateReviewViewController;
    let vscode: any;

    beforeEach(() => {
        jest.clearAllMocks();
        vscode = require('vscode');

        // Default vscode mocks
        vscode.window.showWarningMessage = jest.fn().mockResolvedValue(undefined);
        vscode.window.showInformationMessage = jest.fn().mockResolvedValue(undefined);
        vscode.window.showErrorMessage = jest.fn().mockResolvedValue(undefined);
        vscode.window.showInputBox = jest.fn().mockResolvedValue(undefined);
        vscode.window.withProgress = jest.fn().mockImplementation(
            async (_opts: any, task: any) => { await task(); },
        );
        // eslint-disable-next-line @typescript-eslint/naming-convention
        vscode.ProgressLocation = { Notification: 15 };
    });

    afterEach(() => {
        view?.dispose();
    });

    // =========================================================================
    // No packages selected
    // =========================================================================

    describe('apply-selected with no packages', () => {
        it('shows warning and does not call buildApplyPlan', async () => {
            const { mockLogger, mockTelemetry, mockDeviceService } = makeDeps();
            view = new UpdateReviewViewController({ logger: mockLogger, telemetry: mockTelemetry, deviceService: mockDeviceService });
            await view.render({ deviceId: 'dev-001' });

            await view.handleMessage({ type: 'apply-selected', packages: [] } as any);

            expect(vscode.window.showWarningMessage).toHaveBeenCalled();
            expect(updateReconciliationService.buildApplyPlan).not.toHaveBeenCalled();
        });
    });

    // =========================================================================
    // All packages dropped during re-validation
    // =========================================================================

    describe('apply-selected when plan.toApply is empty', () => {
        it('shows info message, no confirm modal, no executeApplyPlan', async () => {
            (updateReconciliationService.buildApplyPlan as jest.Mock).mockResolvedValue(
                makePlan({
                    toApply: [],
                    skipped: [{ package: 'curl', reason: 'now-pinned' }],
                }),
            );

            const { mockLogger, mockTelemetry, mockDeviceService } = makeDeps();
            view = new UpdateReviewViewController({ logger: mockLogger, telemetry: mockTelemetry, deviceService: mockDeviceService });
            await view.render({ deviceId: 'dev-001' });

            await view.handleMessage({ type: 'apply-selected', packages: ['curl'] } as any);

            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
                expect.stringContaining('now-pinned'),
            );
            // No modal confirmation, no execute
            expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
            expect(updateReconciliationService.executeApplyPlan).not.toHaveBeenCalled();
        });
    });

    // =========================================================================
    // Confirmation modal content
    // =========================================================================

    describe('apply-selected — confirmation modal', () => {
        it('modal text includes provider, toApply packages, and reboot warning', async () => {
            (updateReconciliationService.buildApplyPlan as jest.Mock).mockResolvedValue(makePlan());
            (updateReconciliationService.executeApplyPlan as jest.Mock).mockResolvedValue(makeSuccessResult());
            vscode.window.showWarningMessage = jest.fn().mockResolvedValue('Apply updates');

            const { mockLogger, mockTelemetry, mockDeviceService } = makeDeps();
            view = new UpdateReviewViewController({ logger: mockLogger, telemetry: mockTelemetry, deviceService: mockDeviceService });
            await view.render({ deviceId: 'dev-001' });

            await view.handleMessage({ type: 'apply-selected', packages: ['curl'] } as any);

            const modalText = (vscode.window.showWarningMessage as jest.Mock).mock.calls[0][0] as string;
            expect(modalText).toContain('apt');
            expect(modalText).toContain('curl');
            expect(modalText).toContain('reboot');
        });

        it('modal text includes additionalChanges when present', async () => {
            (updateReconciliationService.buildApplyPlan as jest.Mock).mockResolvedValue(
                makePlan({ additionalChanges: ['libcurl4'] }),
            );
            (updateReconciliationService.executeApplyPlan as jest.Mock).mockResolvedValue(makeSuccessResult());
            vscode.window.showWarningMessage = jest.fn().mockResolvedValue('Apply updates');

            const { mockLogger, mockTelemetry, mockDeviceService } = makeDeps();
            view = new UpdateReviewViewController({ logger: mockLogger, telemetry: mockTelemetry, deviceService: mockDeviceService });
            await view.render({ deviceId: 'dev-001' });

            await view.handleMessage({ type: 'apply-selected', packages: ['curl'] } as any);

            const modalText = (vscode.window.showWarningMessage as jest.Mock).mock.calls[0][0] as string;
            expect(modalText).toContain('libcurl4');
        });

        it('modal text includes skipped packages with reasons', async () => {
            (updateReconciliationService.buildApplyPlan as jest.Mock).mockResolvedValue(
                makePlan({ skipped: [{ package: 'openssl', reason: 'now-held' }] }),
            );
            (updateReconciliationService.executeApplyPlan as jest.Mock).mockResolvedValue(makeSuccessResult());
            vscode.window.showWarningMessage = jest.fn().mockResolvedValue('Apply updates');

            const { mockLogger, mockTelemetry, mockDeviceService } = makeDeps();
            view = new UpdateReviewViewController({ logger: mockLogger, telemetry: mockTelemetry, deviceService: mockDeviceService });
            await view.render({ deviceId: 'dev-001' });

            await view.handleMessage({ type: 'apply-selected', packages: ['curl', 'openssl'] } as any);

            const modalText = (vscode.window.showWarningMessage as jest.Mock).mock.calls[0][0] as string;
            expect(modalText).toContain('openssl');
            expect(modalText).toContain('now-held');
        });

        it('modal text includes DGX note when dgxControllerAbsent is true', async () => {
            (updateReconciliationService.buildApplyPlan as jest.Mock).mockResolvedValue(
                makePlan({ dgxControllerAbsent: true }),
            );
            (updateReconciliationService.executeApplyPlan as jest.Mock).mockResolvedValue(makeSuccessResult());
            vscode.window.showWarningMessage = jest.fn().mockResolvedValue('Apply updates');

            const { mockLogger, mockTelemetry, mockDeviceService } = makeDeps();
            view = new UpdateReviewViewController({ logger: mockLogger, telemetry: mockTelemetry, deviceService: mockDeviceService });
            await view.render({ deviceId: 'dev-001' });

            await view.handleMessage({ type: 'apply-selected', packages: ['curl'] } as any);

            const modalText = (vscode.window.showWarningMessage as jest.Mock).mock.calls[0][0] as string;
            expect(modalText).toContain('spark_updatectl');
        });
    });

    // =========================================================================
    // Cancel gate
    // =========================================================================

    describe('apply-selected — cancel gate', () => {
        it('does not call executeApplyPlan when user cancels the modal', async () => {
            (updateReconciliationService.buildApplyPlan as jest.Mock).mockResolvedValue(makePlan());
            // User dismisses — showWarningMessage returns undefined
            vscode.window.showWarningMessage = jest.fn().mockResolvedValue(undefined);

            const { mockLogger, mockTelemetry, mockDeviceService } = makeDeps();
            view = new UpdateReviewViewController({ logger: mockLogger, telemetry: mockTelemetry, deviceService: mockDeviceService });
            await view.render({ deviceId: 'dev-001' });

            await view.handleMessage({ type: 'apply-selected', packages: ['curl'] } as any);

            expect(updateReconciliationService.executeApplyPlan).not.toHaveBeenCalled();
        });
    });

    // =========================================================================
    // Successful apply
    // =========================================================================

    describe('apply-selected — success', () => {
        it('calls executeApplyPlan with the built plan and shows info message', async () => {
            const plan = makePlan();
            (updateReconciliationService.buildApplyPlan as jest.Mock).mockResolvedValue(plan);
            (updateReconciliationService.executeApplyPlan as jest.Mock).mockResolvedValue(makeSuccessResult());
            vscode.window.showWarningMessage = jest.fn().mockResolvedValue('Apply updates');

            const { mockLogger, mockTelemetry, mockDeviceService } = makeDeps();
            view = new UpdateReviewViewController({ logger: mockLogger, telemetry: mockTelemetry, deviceService: mockDeviceService });
            await view.render({ deviceId: 'dev-001' });

            await view.handleMessage({ type: 'apply-selected', packages: ['curl'] } as any);

            expect(updateReconciliationService.executeApplyPlan).toHaveBeenCalledWith(
                expect.objectContaining({ id: 'dev-001' }),
                plan,
                undefined,
            );
            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
                expect.stringContaining('1 update(s)'),
            );
        });

        it('re-renders the panel after success', async () => {
            (updateReconciliationService.buildApplyPlan as jest.Mock).mockResolvedValue(makePlan());
            (updateReconciliationService.executeApplyPlan as jest.Mock).mockResolvedValue(makeSuccessResult());
            vscode.window.showWarningMessage = jest.fn().mockResolvedValue('Apply updates');

            const { mockLogger, mockTelemetry, mockDeviceService } = makeDeps();
            view = new UpdateReviewViewController({ logger: mockLogger, telemetry: mockTelemetry, deviceService: mockDeviceService });
            await view.render({ deviceId: 'dev-001' });

            const renderSpy = jest.spyOn(view, 'render');
            await view.handleMessage({ type: 'apply-selected', packages: ['curl'] } as any);

            // render is called again after apply completes
            expect(renderSpy).toHaveBeenCalledWith({ deviceId: 'dev-001' });
        });
    });

    // =========================================================================
    // Failure path
    // =========================================================================

    describe('apply-selected — failure', () => {
        it('shows error message on apply failure', async () => {
            (updateReconciliationService.buildApplyPlan as jest.Mock).mockResolvedValue(makePlan());
            (updateReconciliationService.executeApplyPlan as jest.Mock).mockResolvedValue(
                makeSuccessResult({ success: false, applied: [], note: 'dpkg lock held' }),
            );
            vscode.window.showWarningMessage = jest.fn().mockResolvedValue('Apply updates');

            const { mockLogger, mockTelemetry, mockDeviceService } = makeDeps();
            view = new UpdateReviewViewController({ logger: mockLogger, telemetry: mockTelemetry, deviceService: mockDeviceService });
            await view.render({ deviceId: 'dev-001' });

            await view.handleMessage({ type: 'apply-selected', packages: ['curl'] } as any);

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
                expect.stringContaining('dpkg lock held'),
            );
        });
    });

    // =========================================================================
    // Password flow
    // =========================================================================

    describe('apply-selected — password flow', () => {
        it('prompts for password when requiresPassword is true and retries', async () => {
            const plan = makePlan();
            (updateReconciliationService.buildApplyPlan as jest.Mock).mockResolvedValue(plan);
            (updateReconciliationService.executeApplyPlan as jest.Mock)
                .mockResolvedValueOnce(makeSuccessResult({ success: false, applied: [], requiresPassword: true }))
                .mockResolvedValueOnce(makeSuccessResult());
            vscode.window.showWarningMessage = jest.fn().mockResolvedValue('Apply updates');
            vscode.window.showInputBox = jest.fn().mockResolvedValue('mypassword');

            const { mockLogger, mockTelemetry, mockDeviceService } = makeDeps();
            view = new UpdateReviewViewController({ logger: mockLogger, telemetry: mockTelemetry, deviceService: mockDeviceService });
            await view.render({ deviceId: 'dev-001' });

            await view.handleMessage({ type: 'apply-selected', packages: ['curl'] } as any);

            expect(vscode.window.showInputBox).toHaveBeenCalledWith(
                expect.objectContaining({ password: true }),
            );
            // Second call to executeApplyPlan with the supplied password
            expect(updateReconciliationService.executeApplyPlan).toHaveBeenCalledTimes(2);
            expect(updateReconciliationService.executeApplyPlan).toHaveBeenLastCalledWith(
                expect.anything(), plan, 'mypassword',
            );
        });

        it('aborts without retry when user cancels the password prompt', async () => {
            (updateReconciliationService.buildApplyPlan as jest.Mock).mockResolvedValue(makePlan());
            (updateReconciliationService.executeApplyPlan as jest.Mock).mockResolvedValue(
                makeSuccessResult({ success: false, applied: [], requiresPassword: true }),
            );
            vscode.window.showWarningMessage = jest.fn().mockResolvedValue('Apply updates');
            vscode.window.showInputBox = jest.fn().mockResolvedValue(undefined); // user cancelled

            const { mockLogger, mockTelemetry, mockDeviceService } = makeDeps();
            view = new UpdateReviewViewController({ logger: mockLogger, telemetry: mockTelemetry, deviceService: mockDeviceService });
            await view.render({ deviceId: 'dev-001' });

            await view.handleMessage({ type: 'apply-selected', packages: ['curl'] } as any);

            // Only one call — no retry
            expect(updateReconciliationService.executeApplyPlan).toHaveBeenCalledTimes(1);
        });
    });
});
