const { Telegraf, Markup } = require('telegraf');
const { google } = require('googleapis');
const express = require('express');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const bot = new Telegraf(process.env.BOT_TOKEN);

// Список адміністраторів для отримання сповіщень (через кому в .env)
const ADMIN_IDS = (process.env.ADMIN_TELEGRAM_ID || '').split(',').map(id => id.trim()).filter(Boolean);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '12345';

// Ініціалізація Google Sheets API
const auth = new google.auth.GoogleAuth({
  keyFile: 'google-credentials.json',
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({ version: 'v4', auth });
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

const getCurrentDate = () => new Date().toISOString().split('T')[0];
const getCurrentTime = () => new Date().toTimeString().split(' ')[0];
const getCurrentMonthName = () => {
  const d = new Date();
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${months[d.getMonth()]}_${d.getFullYear()}`;
};

// Мідлваре перевірки пароля для запитів до API
function checkPasswordAuth(req, res, next) {
  const providedPassword = req.headers['x-admin-password'];
  if (!providedPassword || providedPassword !== ADMIN_PASSWORD) {
    return res.status(403).json({ error: 'Невірний пароль доступу' });
  }
  next();
}

const userStates = {};
const BASE_URL = process.env.RENDER_EXTERNAL_URL;

const keyboardRows = [
  ['📥 Прихід', '📤 Відхід'],
  ['🔧 Взяти пристрій', '📋 Завершити пристрій'],
  ['⚠️ Проблема з пристроєм', '📊 Скільки пристроїв у роботі']
];

if (BASE_URL && BASE_URL.startsWith('https://')) {
  keyboardRows.push([Markup.button.webApp('🖥 Адмін-панель (Mini App)', BASE_URL)]);
}
const mainKeyboard = Markup.keyboard(keyboardRows).resize();

// --- ЕНДПОІНТ АВТОРИЗАЦІЇ ТА СПОВІЩЕНЬ ---
app.post('/api/login', async (req, res) => {
  const { password, telegramUser } = req.body;
  
  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(403).json({ success: false, error: 'Невірний пароль' });
  }

  // Надсилаємо сповіщення всім адміністраторам
  if (telegramUser) {
    const userInfo = `👤 Користувач: ${telegramUser.first_name || 'Невідомо'} (@${telegramUser.username || 'немає'}, ID: \`${telegramUser.id}\`)`;
    const time = new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });
    const message = `🚨 **Вхід в адмін-панель!**\n\n${userInfo}\n⏱ Час: ${time}`;

    for (const adminId of ADMIN_IDS) {
      try {
        await bot.telegram.sendMessage(adminId, message, { parse_mode: 'Markdown' });
      } catch (e) {
        console.error(`Не вдалося надіслати сповіщення адміну ${adminId}:`, e.message);
      }
    }
  }

  res.json({ success: true });
});

// --- ЗАХИЩЕНЕ API ДЛЯ MINI APP ---

app.get('/api/stats', checkPasswordAuth, async (req, res) => {
  try {
    const attRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Attendance!A:F' });
    const devRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Devices!A:F' });
    
    let settingsRows = [];
    try {
      const setRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Settings!A:C' });
      settingsRows = setRes.data.values || [];
    } catch (e) {}

    let advRows = [];
    try {
      const advRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Advances!A:C' });
      advRows = advRes.data.values || [];
    } catch (e) {}

    res.json({
      attendance: (attRes.data.values || []).slice(1),
      devices: (devRes.data.values || []).slice(1),
      settings: settingsRows,
      advances: advRows.slice(1)
    });
  } catch (err) {
    console.error('API Error:', err);
    res.status(500).json({ error: 'Помилка читання даних' });
  }
});

app.post('/api/allowed-users', checkPasswordAuth, async (req, res) => {
  const { userId, userName, action } = req.body;
  try {
    let rows = [];
    try {
      const setRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Settings!A:C' });
      rows = setRes.data.values || [];
    } catch (e) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        resource: { requests: [{ addSheet: { properties: { title: 'Settings' } } }] }
      });
    }

    if (action === 'add') {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Settings!A:C',
        valueInputOption: 'USER_ENTERED',
        resource: { values: [['ALLOWED_USER', userId, userName]] }
      });
    } else if (action === 'remove') {
      const updatedRows = rows.filter(r => !(r[0] === 'ALLOWED_USER' && String(r[1]) === String(userId)));
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `Settings!A1:C${updatedRows.length || 1}`,
        valueInputOption: 'USER_ENTERED',
        resource: { values: updatedRows.length ? updatedRows : [['', '', '']] }
      });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/set-rate', checkPasswordAuth, async (req, res) => {
  const { userId, rate } = req.body;
  try {
    let rows = [];
    try {
      const setRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Settings!A:C' });
      rows = setRes.data.values || [];
    } catch (e) {}

    let found = false;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i][0] === 'RATE' && String(rows[i][1]) === String(userId)) {
        rows[i][2] = rate;
        found = true;
        break;
      }
    }
    if (!found) {
      rows.push(['RATE', userId, rate]);
    }

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `Settings!A1:C${rows.length}`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: rows }
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/add-advance', checkPasswordAuth, async (req, res) => {
  const { userId, amount } = req.body;
  try {
    try {
      await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Advances!A:C' });
    } catch (e) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        resource: { requests: [{ addSheet: { properties: { title: 'Advances' } } }] }
      });
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Advances!A:C',
        valueInputOption: 'USER_ENTERED',
        resource: { values: [['Date', 'UserId', 'Amount']] }
      });
    }

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Advances!A:C',
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[getCurrentDate(), userId, amount]] }
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/close-month', checkPasswordAuth, async (req, res) => {
  try {
    const monthSheetName = getCurrentMonthName();
    
    const attRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Attendance!A:F' });
    const devRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Devices!A:F' });

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      resource: { requests: [{ addSheet: { properties: { title: monthSheetName } } }] }
    });

    let archiveData = [
      ['--- ATTENDANCE ---'],
      ...(attRes.data.values || []),
      [],
      ['--- DEVICES ---'],
      ...(devRes.data.values || [])
    ];

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${monthSheetName}!A1`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: archiveData }
    });

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Attendance!A:F',
      valueInputOption: 'USER_ENTERED',
      resource: { values: [['Date', 'UserId', 'UserName', 'InTime', 'OutTime', 'Hours']] }
    });

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Devices!A:F',
      valueInputOption: 'USER_ENTERED',
      resource: { values: [['Date', 'UserId', 'SerialNumber', 'StartTime', 'EndTime', 'Status']] }
    });

    res.json({ success: true, sheetName: monthSheetName });
  } catch (err) {
    console.error('Помилка закриття місяця:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- Телеграм бот ---

bot.command('start', async (ctx) => {
  await ctx.reply('Вітаю! Оберіть потрібну дію за допомогою меню нижче:', mainKeyboard);
});

const handleIn = async (ctx) => {
  const userId = ctx.from.id;
  const userName = ctx.from.first_name || 'Співробітник';
  const date = getCurrentDate();
  const time = getCurrentTime();

  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Attendance!A:F' });
    const rows = res.data.values || [];
    let hasToday = false;

    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][1]) === String(userId) && rows[i][0] === date) {
        hasToday = true;
      }
    }

    if (hasToday) return ctx.reply('⚠️ Ви вже зареєстрували прихід сьогодні.', mainKeyboard);

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Attendance!A:F',
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[date, userId, userName, time, '', '']] }
    });
    await ctx.reply(`✅ Прихід зафіксовано о ${time}. Доброго дня, ${userName}!`, mainKeyboard);
  } catch (err) {
    await ctx.reply('❌ Помилка запису в Google Таблицю.', mainKeyboard);
  }
};

bot.command('in', handleIn);
bot.hears('📥 Прихід', handleIn);

const handleOut = async (ctx) => {
  const userId = ctx.from.id;
  const date = getCurrentDate();
  const time = getCurrentTime();

  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Attendance!A:F' });
    const rows = res.data.values || [];
    let todayRowIndex = -1;

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === date && String(rows[i][1]) === String(userId)) {
        todayRowIndex = i + 1;
        break;
      }
    }

    if (todayRowIndex === -1) return ctx.reply('⚠️ Ви не робили відмітку приходу сьогодні!', mainKeyboard);

    const checkInTime = rows[todayRowIndex - 1][3];
    const [inH, inM] = checkInTime.split(':').map(Number);
    const [outH, outM] = time.split(':').map(Number);
    const totalHours = Math.max(0, ((outH * 60 + outM) - (inH * 60 + inM)) / 60).toFixed(2);

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `Attendance!E${todayRowIndex}:F${todayRowIndex}`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[time, totalHours]] }
    });

    await ctx.reply(`👋 Ухід зафіксовано о ${time}. Відпрацьовано годин: ${totalHours}.`, mainKeyboard);
  } catch (err) {
    await ctx.reply('❌ Помилка оновлення таблиці.', mainKeyboard);
  }
};

bot.command('out', handleOut);
bot.hears('📤 Відхід', handleOut);

bot.hears('🔧 Взяти пристрій', async (ctx) => {
  userStates[ctx.from.id] = 'WAITING_FOR_SERIAL';
  await ctx.reply('Введіть серійний номер пристрою:', Markup.forceReply());
});

bot.hears('📋 Завершити пристрій', async (ctx) => {
  const userId = ctx.from.id;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Devices!A:F' });
  const rows = res.data.values || [];
  const active = [];
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][1]) === String(userId) && (rows[i][5] === 'In_Progress' || rows[i][5] === 'Problem') && !rows[i][4]) {
      active.push(Markup.button.callback(`Завершити: ${rows[i][2]}`, `finish_${i + 1}`));
    }
  }
  if (!active.length) return ctx.reply('ℹ️ Немає активних пристроїв.', mainKeyboard);
  await ctx.reply('Виберіть пристрій для завершення:', Markup.inlineKeyboard(active));
});

bot.action(/^finish_(\d+)$/, async (ctx) => {
  const row = ctx.match[1];
  const time = getCurrentTime();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `Devices!E${row}:F${row}`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: [[time, 'Completed']] }
  });
  await ctx.answerCbQuery('Закрито!');
  await ctx.editMessageText(`✅ Пристрій успішно завершено о ${time}.`);
});

bot.hears('⚠️ Проблема з пристроєм', async (ctx) => {
  const userId = ctx.from.id;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Devices!A:F' });
  const rows = res.data.values || [];
  const active = [];
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][1]) === String(userId) && rows[i][5] === 'In_Progress') {
      active.push(Markup.button.callback(`Проблема: ${rows[i][2]}`, `problem_${i + 1}`));
    }
  }
  if (!active.length) return ctx.reply('ℹ️ Немає активних пристроїв.', mainKeyboard);
  await ctx.reply('Виберіть пристрій зі скрутністю:', Markup.inlineKeyboard(active));
});

bot.action(/^problem_(\d+)$/, async (ctx) => {
  const row = ctx.match[1];
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `Devices!F${row}`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: [['Problem']] }
  });
  await ctx.answerCbQuery('Статус змінено!');
  await ctx.editMessageText('⚠️ Статус змінено на Problem.');
});

bot.hears('📊 Скільки пристроїв у роботі', async (ctx) => {
  const userId = ctx.from.id;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Devices!A:F' });
  const rows = res.data.values || [];
  const count = rows.slice(1).filter(d => String(d[1]) === String(userId) && (d[5] === 'In_Progress' || d[5] === 'Problem') && !d[4]).length;
  await ctx.reply(`📊 У вас зараз у роботі пристроїв: ${count}`, mainKeyboard);
});

bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  if (userStates[userId] === 'WAITING_FOR_SERIAL') {
    const serial = ctx.message.text.trim();
    delete userStates[userId];
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Devices!A:F',
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[getCurrentDate(), userId, serial, getCurrentTime(), '', 'In_Progress']] }
    });
    await ctx.reply(`🔧 Пристрій \`${serial}\` додано в роботу.`, { parse_mode: 'Markdown', ...mainKeyboard });
  }
});

app.listen(PORT, () => console.log(`🚀 Сервер запущено на порту ${PORT}`));
bot.launch();