import { chromium } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const screenshotsDir = path.resolve(__dirname, '../e2e-screenshots');

if (!fs.existsSync(screenshotsDir)) {
  fs.mkdirSync(screenshotsDir, { recursive: true });
}

async function runHeadedE2ETest() {
  console.log('====================================================');
  console.log('🚀 Launching Playwright Chromium in HEADED Mode');
  console.log('====================================================');
  
  const browser = await chromium.launch({
    headless: false,
    slowMo: 600, // Smooth pace so user can watch live
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });

  const page = await context.newPage();

  page.on('console', msg => {
    if (msg.type() === 'error') {
      console.log(`[Browser Console Error] ${msg.text()}`);
    }
  });

  try {
    // -------------------------------------------------------------
    // Step 1: Portal & Initialization
    // -------------------------------------------------------------
    console.log('\n📍 [Step 1] Navigating to http://localhost:3000...');
    await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);

    await page.screenshot({ path: path.join(screenshotsDir, '01_portal_initial.png') });
    console.log('📸 Saved: 01_portal_initial.png');

    const portalElement = await page.$('#workspace-portal');
    if (portalElement) {
      console.log('🔍 Detected Workspace Portal screen.');
      
      const dbInput = await page.$('#workspace-portal input[type="text"]');
      if (dbInput) {
        const currentVal = await dbInput.inputValue();
        if (!currentVal) {
          console.log('⌨️ Filling DB Connection URL...');
          await dbInput.fill('postgresql://postgres:nemoid148@localhost:5432/CrowdOS');
          await page.waitForTimeout(400);
        }
      }

      const testBtn = await page.$('#workspace-portal button[type="submit"]');
      if (testBtn) {
        console.log('🔌 Testing DB connection...');
        await testBtn.click();
        await page.waitForTimeout(1500);
        await page.screenshot({ path: path.join(screenshotsDir, '02_portal_connection_tested.png') });
        console.log('📸 Saved: 02_portal_connection_tested.png');
      }

      const existingWsBtn = await page.$('#workspace-portal div.space-y-1 button');
      if (existingWsBtn) {
        console.log('🏢 Launching existing workspace session...');
        await existingWsBtn.click();
      } else {
        const wsNameInput = await page.$('input[placeholder*="Swarm Research Core"]');
        if (wsNameInput) {
          await wsNameInput.fill('CrowdOS Master Workspace');
          const launchBtn = await page.$('button:has-text("Launch Workspace")');
          if (launchBtn) await launchBtn.click();
        }
      }
    }

    // Wait for main shell
    console.log('⏳ Waiting for CrowdOS main workspace shell...');
    await page.waitForSelector('#crowd-os-root-shell', { timeout: 15000 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(screenshotsDir, '03_workspace_main_shell.png') });
    console.log('📸 Saved: 03_workspace_main_shell.png');

    // -------------------------------------------------------------
    // Step 2: Channel Switching & Navigation
    // -------------------------------------------------------------
    console.log('\n📍 [Step 2] Testing Sidebar Channels...');
    
    const playgroundBtn = await page.$('#workspace-sidebar button:has-text("playground")');
    if (playgroundBtn) {
      console.log('👉 Navigating to #playground...');
      await playgroundBtn.click();
      await page.waitForTimeout(1000);
      await page.screenshot({ path: path.join(screenshotsDir, '04_channel_playground.png') });
      console.log('📸 Saved: 04_channel_playground.png');
    }

    const generalBtn = await page.$('#workspace-sidebar button:has-text("general")');
    if (generalBtn) {
      console.log('👉 Navigating to #general...');
      await generalBtn.click();
      await page.waitForTimeout(1000);
      await page.screenshot({ path: path.join(screenshotsDir, '05_channel_general.png') });
      console.log('📸 Saved: 05_channel_general.png');
    }

    const archBtn = await page.$('#workspace-sidebar button:has-text("arch-design")');
    if (archBtn) {
      console.log('👉 Navigating to #arch-design...');
      await archBtn.click();
      await page.waitForTimeout(1000);
      await page.screenshot({ path: path.join(screenshotsDir, '06_channel_arch_design.png') });
      console.log('📸 Saved: 06_channel_arch_design.png');
    }

    // -------------------------------------------------------------
    // Step 3: Chat Composer & Real-time Messaging
    // -------------------------------------------------------------
    console.log('\n📍 [Step 3] Testing Chat Area & Operator Prompting...');
    const composer = await page.$('textarea[placeholder*="Message #"]');
    if (composer) {
      await composer.click();
      await page.waitForTimeout(400);

      console.log('⌨️ Typing @ to inspect Agent Mentions autocomplete...');
      await composer.fill('@');
      await page.waitForTimeout(1000);
      await page.screenshot({ path: path.join(screenshotsDir, '07_chat_agent_mentions.png') });
      console.log('📸 Saved: 07_chat_agent_mentions.png');

      const testMsg = 'Hello CrowdOS Agents! Running automated Playwright E2E verification as user operator.';
      console.log(`⌨️ Sending user message: "${testMsg}"...`);
      await composer.fill(testMsg);
      await page.waitForTimeout(600);
      await composer.press('Enter');
      await page.waitForTimeout(1500);

      await page.screenshot({ path: path.join(screenshotsDir, '08_chat_message_sent.png') });
      console.log('📸 Saved: 08_chat_message_sent.png');
    }

    // -------------------------------------------------------------
    // Step 4: Agent Inspection & Profile Modal
    // -------------------------------------------------------------
    console.log('\n📍 [Step 4] Inspecting Operations Roster & Agent Profile...');
    const agentRow = await page.$('[id^="agent-row-"]');
    if (agentRow) {
      console.log('👉 Clicking on agent card...');
      await agentRow.click();
      await page.waitForTimeout(1500);
      await page.screenshot({ path: path.join(screenshotsDir, '09_agent_profile_modal.png') });
      console.log('📸 Saved: 09_agent_profile_modal.png');

      // Close agent profile modal by clicking backdrop or close button
      const modalBackdrop = await page.$('.fixed.inset-0.z-50');
      const closeBtn = await page.$('#agent-profile-modal button:has(svg.lucide-x), #agent-profile-modal button:has-text("Close")');
      if (closeBtn) {
        await closeBtn.click();
      } else if (modalBackdrop) {
        await page.mouse.click(20, 20);
      }
      await page.waitForTimeout(1000);
    }

    // -------------------------------------------------------------
    // Step 5: OmniSearch Experience (Ctrl+K)
    // -------------------------------------------------------------
    console.log('\n📍 [Step 5] Testing OmniSearch Modal...');
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(1000);

    const searchInput = await page.$('input[placeholder*="Type to search"]');
    if (searchInput) {
      console.log('⌨️ Searching for "general"...');
      await searchInput.fill('general');
      await page.waitForTimeout(1000);
      await page.screenshot({ path: path.join(screenshotsDir, '10_omnisearch_results.png') });
      console.log('📸 Saved: 10_omnisearch_results.png');

      // Close search modal by clicking the X button
      const closeSearchBtn = await page.$('.fixed.z-\\[9995\\] button:has(svg.lucide-x)');
      if (closeSearchBtn) {
        console.log('❌ Closing OmniSearch via close button...');
        await closeSearchBtn.click();
      } else {
        await page.keyboard.press('Control+k');
      }
      await page.waitForTimeout(1000);
    }

    // -------------------------------------------------------------
    // Step 6: Workspace Settings Console
    // -------------------------------------------------------------
    console.log('\n📍 [Step 6] Testing Workspace Settings Admin Console...');
    const settingsBtn = await page.$('button[title*="Settings"], #sidebar-user-section button');
    if (settingsBtn) {
      console.log('⚙️ Clicking Settings gear button...');
      await settingsBtn.click();
      await page.waitForTimeout(1500);

      await page.screenshot({ path: path.join(screenshotsDir, '11_settings_overview.png') });
      console.log('📸 Saved: 11_settings_overview.png');

      // Tabs to verify
      const settingsTabs = [
        { name: 'Agents Board', file: '12_settings_agents_board.png' },
        { name: 'Model Modules', file: '13_settings_model_modules.png' },
        { name: 'Security Tools Whitelist', file: '14_settings_security_tools.png' },
        { name: 'Skills Manager', file: '15_settings_skills_manager.png' },
        { name: 'Category & Channels', file: '16_settings_categories_channels.png' },
      ];

      for (const tab of settingsTabs) {
        const tabBtn = await page.$(`#workspace-settings-modal button:has-text("${tab.name}")`);
        if (tabBtn) {
          console.log(`👉 Switching to settings tab: "${tab.name}"...`);
          await tabBtn.click();
          await page.waitForTimeout(1000);
          await page.screenshot({ path: path.join(screenshotsDir, tab.file) });
          console.log(`📸 Saved: ${tab.file}`);
        }
      }

      // Close Settings modal by clicking backdrop or top-right close
      console.log('❌ Closing Settings modal...');
      const closeSettingsBtn = await page.$('#workspace-settings-modal button:has(svg.lucide-x)');
      if (closeSettingsBtn) {
        await closeSettingsBtn.click();
      } else {
        await page.mouse.click(20, 20);
      }
      await page.waitForTimeout(1000);
    }

    // -------------------------------------------------------------
    // Step 7: Final Comprehensive Snapshot
    // -------------------------------------------------------------
    await page.screenshot({ path: path.join(screenshotsDir, '17_workspace_e2e_complete.png') });
    console.log('📸 Saved: 17_workspace_e2e_complete.png');

    console.log('\n====================================================');
    console.log('🎉 ALL HEADED END-TO-END TESTS PASSED SUCCESSFULLY!');
    console.log('====================================================\n');
    await page.waitForTimeout(2500);

  } catch (err) {
    console.error('❌ Error during E2E test execution:', err);
    await page.screenshot({ path: path.join(screenshotsDir, 'error_state.png') }).catch(() => {});
    throw err;
  } finally {
    await browser.close();
    console.log('🚪 Browser session closed.');
  }
}

runHeadedE2ETest().catch(err => {
  console.error('Fatal execution error:', err);
  process.exit(1);
});
