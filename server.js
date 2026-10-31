const { Telegraf, Markup } = require('telegraf');
const { google } = require('googleapis');
const express = require('express');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID || null;

// Ініціалізація авторизації Google Sheets API через сервісний акаунт
const auth = new google.auth.GoogleAuth({
  keyFile: 'google-credentials.json',
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({ version: 'v4', auth });
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

// Роздача статичних файлів для Mini App
app.use(express.static(path.join(__dirname, 'public')));

// API для Telegram Mini App
app.get('/api/stats', async (req, res) => {
  try {
    const attRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Attendance!A:F',
    });
    const devRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Devices!A:F',
    });

    const attendance = (attRes.data.values || []).slice(1);
    const devices = (devRes.data.values || []).slice(1);

    const activeDevicesCount = devices.filter(d => (d[5] === 'In_Progress' || d[5] === 'Problem') && !d[4]).length;

    res.json({ attendance, activeDevicesCount });
  } catch (err) {
    console.error('Помилка API stats:', err);
    res.status(500).json({ error: 'Помилка читання даних' });
  }
});

// Допоміжні функції для дати та часу
const getCurrentDate = () => new Date().toISOString().split('T')[0];
const getCurrentTime = () => new Date().toTimeString().split(' ')[0];

// Зберігання тимчасових станів користувачів (для очікування серійного номера)
const userStates = {};

// Динамічне визначення URL для Mini App (працює і локально, і на Render з HTTPS)
const BASE_URL = process.env.RENDER_EXTERNAL_URL;

// Формуємо основне меню
const keyboardRows = [
  ['📥 Прихід', '📤 Відхід'],
  ['🔧 Взяти пристрій', '📋 Завершити пристрій'],
  ['⚠️ Проблема з пристроєм', '📊 Скільки пристроїв у роботі']
];

// Додаємо кнопку Mini App лише тоді, коли є реальна HTTPS-адреса (у хмарі Render)
if (BASE_URL && BASE_URL.startsWith('https://')) {
  keyboardRows.push([Markup.button.webApp('🖥 Адмін-панель (Mini App)', BASE_URL)]);
}

const mainKeyboard = Markup.keyboard(keyboardRows).resize();

// Команда /start для появи меню
bot.command('start', async (ctx) => {
  await ctx.reply('Вітаю! Оберіть потрібну дію за допомогою меню нижче:', mainKeyboard);
});

// --- 1. ПРИХІД НА РОБОТУ (З ПЕРЕВІРКАМИ) ---
const handleIn = async (ctx) => {
  const userId = ctx.from.id;
  const userName = ctx.from.first_name || 'Співробітник';
  const date = getCurrentDate();
  const time = getCurrentTime();

  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Attendance!A:F',
    });
    
    const rows = res.data.values || [];
    let hasToday = false;
    let unclosedPastDate = null;

    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][1]) === String(userId)) {
        const rowDate = rows[i][0];
        const inTime = rows[i][3];
        const outTime = rows[i][4];

        if (rowDate === date) {
          hasToday = true;
        }
        if (rowDate !== date && inTime && !outTime) {
          unclosedPastDate = rowDate;
        }
      }
    }

    if (hasToday) {
      return ctx.reply('⚠️ Ви вже зареєстрували прихід сьогодні. Повторна реєстрація неможлива.', mainKeyboard);
    }

    if (unclosedPastDate) {
      const adminMsg = `⚠️ Увага! У співробітника ${userName} (ID: ${userId}) виявлено незакритий робочий день від ${unclosedPastDate} (відсутній ухід).`;
      if (ADMIN_ID) {
        await bot.telegram.sendMessage(ADMIN_ID, adminMsg).catch(() => {});
      }
      return ctx.reply(`⚠️ У вас є незакритий робочий день від ${unclosedPastDate} без відмітки уходу! Адміністратора сповіщено для виправлення в Google Таблиці.`, mainKeyboard);
    }

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Attendance!A:F',
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [[date, userId, userName, time, '', '']]
      }
    });
    await ctx.reply(`✅ Прихід зафіксовано о ${time}. Доброго робочого дня, ${userName}!`, mainKeyboard);
  } catch (err) {
    console.error('Помилка запису приходу:', err);
    await ctx.reply('❌ Помилка під час запису в Google Таблицю.', mainKeyboard);
  }
};

bot.command('in', handleIn);
bot.hears('📥 Прихід', handleIn);

// --- 2. ВІДБУТТЯ З РОБОТИ (З ПЕРЕВІРКАМИ) ---
const handleOut = async (ctx) => {
  const userId = ctx.from.id;
  const userName = ctx.from.first_name || 'Співробітник';
  const date = getCurrentDate();
  const time = getCurrentTime();

  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Attendance!A:F',
    });
    
    const rows = res.data.values || [];
    let todayRowIndex = -1;
    let alreadyOut = false;

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === date && String(rows[i][1]) === String(userId)) {
        todayRowIndex = i + 1;
        if (rows[i][4]) {
          alreadyOut = true;
        }
        break;
      }
    }

    if (todayRowIndex === -1) {
      const adminMsg = `⚠️ Помилка табеля: співробітник ${userName} (ID: ${userId}) намагався натиснути «Відхід» без попередньої відмітки «Прихід» за сьогодні (${date}).`;
      if (ADMIN_ID) {
        await bot.telegram.sendMessage(ADMIN_ID, adminMsg).catch(() => {});
      }
      return ctx.reply('⚠️ Ви не робили відмітку приходу сьогодні! Ухід не може бути зафіксований. Адміністратора сповіщено.', mainKeyboard);
    }

    if (alreadyOut) {
      return ctx.reply('⚠️ Ви вже зафіксували ухід сьогодні. Повторна відмітка неможлива.', mainKeyboard);
    }

    const checkInTime = rows[todayRowIndex - 1][3];
    const [inH, inM] = checkInTime.split(':').map(Number);
    const [outH, outM] = time.split(':').map(Number);
    
    const totalHours = Math.max(0, ((outH * 60 + outM) - (inH * 60 + inM)) / 60).toFixed(2);

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `Attendance!E${todayRowIndex}:F${todayRowIndex}`,
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [[time, totalHours]]
      }
    });

    await ctx.reply(`👋 Відбуття зафіксовано о ${time}. Відпрацьовано годин: ${totalHours}. Гарного відпочинку!`, mainKeyboard);
  } catch (err) {
    console.error('Помилка запису уходу:', err);
    await ctx.reply('❌ Помилка під час оновлення таблиці.', mainKeyboard);
  }
};

bot.command('out', handleOut);
bot.hears('📤 Відхід', handleOut);

// --- 3. ВЗЯТИ ПРИСТРІЙ У РОБОТУ (ОЧІКУВАННЯ НОМЕРА) ---
bot.hears('🔧 Взяти пристрій', async (ctx) => {
  userStates[ctx.from.id] = 'WAITING_FOR_SERIAL';
  await ctx.reply('Будь ласка, введіть серійний номер пристрою наступним повідомленням:', Markup.forceReply());
});

async function saveDeviceStart(ctx, serialNumber) {
  const userId = ctx.from.id;
  const date = getCurrentDate();
  const time = getCurrentTime();

  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Devices!A:F',
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [[date, userId, serialNumber, time, '', 'In_Progress']]
      }
    });
    await ctx.reply(`🔧 Пристрій \`${serialNumber}\` успішно взято в роботу о ${time}.`, { parse_mode: 'Markdown', ...mainKeyboard });
  } catch (err) {
    console.error('Помилка додавання пристрою:', err);
    await ctx.reply('❌ Помилка запису пристрою в таблицю.', mainKeyboard);
  }
}

// --- 4. ЗАВЕРШИТИ РОБОТУ З ПРИСТРОЄМ (ДЛЯ In_Progress та Problem) ---
const handleDeviceStop = async (ctx) => {
  const userId = ctx.from.id;

  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Devices!A:F',
    });
    
    const rows = res.data.values || [];
    const activeDevices = [];

    for (let i = 1; i < rows.length; i++) {
      const status = rows[i][5];
      const endTime = rows[i][4];
      if (String(rows[i][1]) === String(userId) && (status === 'In_Progress' || status === 'Problem') && !endTime) {
        activeDevices.push({ rowIndex: i + 1, serial: rows[i][2] });
      }
    }

    if (activeDevices.length === 0) {
      return ctx.reply('ℹ️ У вас немає активних пристроїв у роботі.', mainKeyboard);
    }

    const buttons = activeDevices.map(d => [
      Markup.button.callback(`Завершити: ${d.serial}`, `finish_${d.rowIndex}`)
    ]);

    await ctx.reply('📋 Виберіть пристрій, роботу над яким ви закінчили:', Markup.inlineKeyboard(buttons));
  } catch (err) {
    console.error('Помилка читання пристроїв:', err);
    await ctx.reply('❌ Помилка під час читання даних із таблиці.', mainKeyboard);
  }
};

bot.command('device_stop', handleDeviceStop);
bot.hears('📋 Завершити пристрій', handleDeviceStop);

bot.action(/^finish_(\d+)$/, async (ctx) => {
  const rowIndex = ctx.match[1];
  const time = getCurrentTime();

  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `Devices!E${rowIndex}:F${rowIndex}`,
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [[time, 'Completed']]
      }
    });

    await ctx.answerCbQuery('Пристрій успішно закрито!');
    await ctx.editMessageText(`✅ Робота над пристроєм завершена о ${time}.`);
  } catch (err) {
    console.error('Помилка закриття пристрою:', err);
    await ctx.answerCbQuery('❌ Помилка збереження.');
  }
});

// --- 5. ПОЗНАЧИТИ ПРОБЛЕМУ З ПРИСТРОЄМ ---
const handleDeviceProblem = async (ctx) => {
  const userId = ctx.from.id;

  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Devices!A:F',
    });
    
    const rows = res.data.values || [];
    const activeDevices = [];

    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][1]) === String(userId) && rows[i][5] === 'In_Progress') {
        activeDevices.push({ rowIndex: i + 1, serial: rows[i][2] });
      }
    }

    if (activeDevices.length === 0) {
      return ctx.reply('ℹ️ У вас немає активних пристроїв у роботі.', mainKeyboard);
    }

    const buttons = activeDevices.map(d => [
      Markup.button.callback(`Проблема: ${d.serial}`, `problem_${d.rowIndex}`)
    ]);

    await ctx.reply('⚠️ Виберіть пристрій, з яким виникла проблема:', Markup.inlineKeyboard(buttons));
  } catch (err) {
    console.error('Помилка читання пристроїв:', err);
    await ctx.reply('❌ Помилка під час читання даних із таблиці.', mainKeyboard);
  }
};

bot.command('device_problem', handleDeviceProblem);
bot.hears('⚠️ Проблема з пристроєм', handleDeviceProblem);

bot.action(/^problem_(\d+)$/, async (ctx) => {
  const rowIndex = ctx.match[1];
  const time = getCurrentTime();

  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `Devices!F${rowIndex}`,
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [['Problem']]
      }
    });

    await ctx.answerCbQuery('Статус змінено на Problem!');
    await ctx.editMessageText(`⚠️ Статус пристрою змінено на **Problem** о ${time}.`, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('Помилка оновлення статусу пристрою:', err);
    await ctx.answerCbQuery('❌ Помилка збереження.');
  }
});

// --- 6. КІЛЬКІСТЬ ПРИСТРОЇВ У РОБОТІ ---
const handleActiveCount = async (ctx) => {
  const userId = ctx.from.id;

  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Devices!A:F',
    });
    
    const rows = res.data.values || [];
    const activeDevices = [];

    for (let i = 1; i < rows.length; i++) {
      const status = rows[i][5];
      const endTime = rows[i][4];
      if (String(rows[i][1]) === String(userId) && (status === 'In_Progress' || status === 'Problem') && !endTime) {
        activeDevices.push({ serial: rows[i][2], status: status, time: rows[i][3] });
      }
    }

    if (activeDevices.length === 0) {
      return ctx.reply('ℹ️ У вас немає активних пристроїв у роботі.', mainKeyboard);
    }

    let message = `📊 У вас зараз у роботі пристроїв: *${activeDevices.length}*:\n\n`;
    activeDevices.forEach((d, index) => {
      const statusText = d.status === 'Problem' ? '⚠️ Проблема' : '🔧 У роботі';
      message += `${index + 1}. Серійний номер: \`${d.serial}\`\n   • Статус: *${statusText}*\n   • Час початку: ${d.time}\n\n`;
    });

    await ctx.reply(message, { parse_mode: 'Markdown', ...mainKeyboard });
  } catch (err) {
    console.error('Помилка підрахунку пристроїв:', err);
    await ctx.reply('❌ Помилка під час читання даних із таблиці.', mainKeyboard);
  }
};

bot.command('devices_count', handleActiveCount);
bot.hears('📊 Скільки пристроїв у роботі', handleActiveCount);

// --- УНІВЕРСАЛЬНИЙ ОБРОБНИК ТЕКСТУ (ОЧІКУВАННЯ СЕРІЙНОГО НОМЕРА) ---
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;

  if (userStates[userId] === 'WAITING_FOR_SERIAL') {
    const serialNumber = ctx.message.text.trim();
    delete userStates[userId];
    await saveDeviceStart(ctx, serialNumber);
  }
});

// Запуск веб-сервера Express та Telegram-бота
app.listen(PORT, () => {
  console.log(`🌐 Веб-сервер Mini App запущено на порту ${PORT}`);
});

bot.launch().then(() => {
  console.log('🤖 Бот успішно запущений і працює!');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));