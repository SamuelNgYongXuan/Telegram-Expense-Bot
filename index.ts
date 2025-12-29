import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { Bot, webhookCallback, InlineKeyboard } from "https://deno.land/x/grammy@v1.8.3/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

// Initialize Supabase client
const supabase = createClient(
  Deno.env.get("DB_URL") || "",
  Deno.env.get("DB_SERVICE_KEY") || ""
);

// Initialize bot
const bot = new Bot(Deno.env.get("BOT_TOKEN") || "");

// Default categories
const DEFAULT_CATEGORIES = [
  "🍔 Food & Drinks",
  "🚗 Transport", 
  "🎬 Entertainment",
  "🛒 Shopping",
  "👔 Apparals",
  "💊 Healthcare",
  "💰 Other"
];

// Singapore timezone offset in minutes
const SG_OFFSET = 8 * 60; // UTC+8

// Helper: Convert UTC date to Singapore time
function toSingaporeTime(date: Date): Date {
  return new Date(date.getTime() + SG_OFFSET * 60 * 1000);
}

// Helper: Get start of day in Singapore, return as UTC for database query
function getStartOfDaySG(): Date {
  const now = new Date();
  const sgTime = toSingaporeTime(now);
  
  // Set to start of day in SG time
  const startOfDaySG = new Date(Date.UTC(
    sgTime.getUTCFullYear(),
    sgTime.getUTCMonth(),
    sgTime.getUTCDate(),
    0, 0, 0, 0
  ));
  
  // Convert back to UTC for database query
  return new Date(startOfDaySG.getTime() - SG_OFFSET * 60 * 1000);
}

// Helper: Get start of month in Singapore, return as UTC for database query
function getStartOfMonthSG(): Date {
  const now = new Date();
  const sgTime = toSingaporeTime(now);
  
  // Set to start of month in SG time
  const startOfMonthSG = new Date(Date.UTC(
    sgTime.getUTCFullYear(),
    sgTime.getUTCMonth(),
    1,
    0, 0, 0, 0
  ));
  
  // Convert back to UTC for database query
  return new Date(startOfMonthSG.getTime() - SG_OFFSET * 60 * 1000);
}

// Helper: Format date in Singapore timezone
function formatDateSG(date: Date): string {
  const sgTime = toSingaporeTime(date);
  return sgTime.toLocaleDateString('en-SG');
}

// Helper: Format time in Singapore timezone
function formatTimeSG(date: Date): string {
  const sgTime = toSingaporeTime(date);
  return sgTime.toLocaleTimeString('en-SG', { hour: '2-digit', minute: '2-digit', hour12: true });
}

// Helper: Get month name in Singapore timezone
function getMonthNameSG(): string {
  const now = new Date();
  const sgTime = toSingaporeTime(now);
  return sgTime.toLocaleString('en-SG', { month: 'long' });
}

// Helper: Get or create user (with upsert for speed)
async function getOrCreateUser(telegramUserId: string) {
  const { data: user } = await supabase
    .from("users")
    .upsert(
      { telegram_user_id: telegramUserId },
      { onConflict: 'telegram_user_id', ignoreDuplicates: false }
    )
    .select("id, custom_categories")
    .single();

  return user;
}

// Helper: Get user's categories (default + custom)
async function getUserCategories(telegramUserId: string): Promise<string[]> {
  const user = await getOrCreateUser(telegramUserId);
  const customCategories = user?.custom_categories || [];
  return [...DEFAULT_CATEGORIES, ...customCategories];
}

// Helper: Parse expense input
function parseExpenseInput(text: string): { amount: number; description: string } | null {
  const match = text.match(/^(\d+(?:\.\d{1,2})?)\s+(.+)$/);
  if (!match) return null;
  
  const amount = parseFloat(match[1]);
  const description = match[2].trim();
  
  if (isNaN(amount) || amount <= 0) return null;
  
  return { amount, description };
}

// Helper: Create category keyboard
async function createCategoryKeyboard(telegramUserId: string) {
  const categories = await getUserCategories(telegramUserId);
  const keyboard = new InlineKeyboard();
  
  for (let i = 0; i < categories.length; i += 2) {
    if (i + 1 < categories.length) {
      keyboard
        .text(categories[i], `cat_${i}`)
        .text(categories[i + 1], `cat_${i + 1}`)
        .row();
    } else {
      keyboard.text(categories[i], `cat_${i}`);
    }
  }
  
  return keyboard;
}

// Command: /start
bot.command("start", async (ctx) => {
  await ctx.reply(
    "Welcome to Expense Tracker! 💰\n\n" +
    "Just type your expense like:\n" +
    "• 50 lunch\n" +
    "• 12.50 coffee\n" +
    "• 100 groceries\n\n" +
    "Commands:\n" +
    "/expenses - View all expenses\n" +
    "/day - Today's summary\n" +
    "/month - Monthly summary\n" +
    "/categories - View expenses by category\n" +
    "/add - Add a custom category\n" +
    "/remove - Remove a custom category"
  );
});

// Command: /expenses
bot.command("expenses", async (ctx) => {
  const telegramUserId = ctx.from?.id.toString();
  if (!telegramUserId) return;

  const user = await getOrCreateUser(telegramUserId);
  
  const { data: expenses } = await supabase
    .from("expense")
    .select("amount, category, description, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(20);

  if (!expenses || expenses.length === 0) {
    await ctx.reply("No expenses recorded yet. Start by typing an amount and description!");
    return;
  }

  let message = "📊 Your Recent Expenses:\n\n";
  
  for (const exp of expenses) {
    const date = formatDateSG(new Date(exp.created_at));
    message += `${date} - $${exp.amount}\n`;
    message += `   ${exp.category} • ${exp.description}\n\n`;
  }

  await ctx.reply(message);
});

// Command: /day
bot.command("day", async (ctx) => {
  const telegramUserId = ctx.from?.id.toString();
  if (!telegramUserId) return;

  const user = await getOrCreateUser(telegramUserId);
  
  const startOfDay = getStartOfDaySG();

  const { data: expenses } = await supabase
    .from("expense")
    .select("amount, category, description, created_at")
    .eq("user_id", user.id)
    .gte("created_at", startOfDay.toISOString());

  if (!expenses || expenses.length === 0) {
    await ctx.reply("No expenses today yet.");
    return;
  }

  const total = expenses.reduce((sum, exp) => sum + parseFloat(exp.amount), 0);

  let message = `📅 Today's Expenses (${formatDateSG(new Date())})\n\n`;
  message += `Total: $${total.toFixed(2)}\n`;
  message += `Transactions: ${expenses.length}\n\n`;
  
  expenses.forEach(exp => {
    const time = formatTimeSG(new Date(exp.created_at));
    message += `${time} - $${exp.amount}\n`;
    message += `   ${exp.category} • ${exp.description}\n\n`;
  });

  await ctx.reply(message);
});

// Command: /month
bot.command("month", async (ctx) => {
  const telegramUserId = ctx.from?.id.toString();
  if (!telegramUserId) return;

  const user = await getOrCreateUser(telegramUserId);
  
  const startOfMonth = getStartOfMonthSG();

  const { data: expenses } = await supabase
    .from("expense")
    .select("amount, category")
    .eq("user_id", user.id)
    .gte("created_at", startOfMonth.toISOString());

  if (!expenses || expenses.length === 0) {
    await ctx.reply("No expenses this month yet.");
    return;
  }

  const total = expenses.reduce((sum, exp) => sum + parseFloat(exp.amount), 0);
  const byCategory: Record<string, number> = {};

  expenses.forEach(exp => {
    byCategory[exp.category] = (byCategory[exp.category] || 0) + parseFloat(exp.amount);
  });

  let message = `📈 Monthly Summary (${getMonthNameSG()})\n\n`;
  message += `Total: $${total.toFixed(2)}\n`;
  message += `Transactions: ${expenses.length}\n\n`;
  message += "By Category:\n";

  Object.entries(byCategory)
    .sort((a, b) => b[1] - a[1])
    .forEach(([cat, amt]) => {
      message += `${cat}: $${amt.toFixed(2)}\n`;
    });

  await ctx.reply(message);
});

// Command: /categories
bot.command("categories", async (ctx) => {
  const telegramUserId = ctx.from?.id.toString();
  if (!telegramUserId) return;

  const user = await getOrCreateUser(telegramUserId);
  
  const { data: expenses } = await supabase
    .from("expense")
    .select("category, amount")
    .eq("user_id", user.id);

  if (!expenses || expenses.length === 0) {
    await ctx.reply("No expenses recorded yet.");
    return;
  }

  const byCategory: Record<string, { total: number; count: number }> = {};

  expenses.forEach(exp => {
    if (!byCategory[exp.category]) {
      byCategory[exp.category] = { total: 0, count: 0 };
    }
    byCategory[exp.category].total += parseFloat(exp.amount);
    byCategory[exp.category].count += 1;
  });

  let message = "📂 Expenses by Category:\n\n";

  Object.entries(byCategory)
    .sort((a, b) => b[1].total - a[1].total)
    .forEach(([cat, data]) => {
      message += `${cat}\n`;
      message += `  $${data.total.toFixed(2)} (${data.count} transactions)\n\n`;
    });

  await ctx.reply(message);
});

// Command: /add
bot.command("add", async (ctx) => {
  const telegramUserId = ctx.from?.id.toString();
  if (!telegramUserId) return;

  // Get the text after /add command
  const args = ctx.message.text.split(/\s+/).slice(1).join(" ").trim();
  
  // If no arguments, show help
  if (!args) {
    await ctx.reply(
      "To add a custom category, use:\n\n" +
      "/add <emoji> <name>\n\n" +
      "Example: /add 🎮 Gaming"
    );
    return;
  }

  const categoryText = args;
  
  const user = await getOrCreateUser(telegramUserId);
  const currentCustom = user?.custom_categories || [];
  
  // Check if category already exists
  const allCategories = await getUserCategories(telegramUserId);
  if (allCategories.includes(categoryText)) {
    await ctx.reply("❌ This category already exists!");
    return;
  }
  
  // Add new category
  const updatedCustom = [...currentCustom, categoryText];
  
  const { error } = await supabase
    .from("users")
    .update({ custom_categories: updatedCustom })
    .eq("telegram_user_id", telegramUserId);

  if (error) {
    await ctx.reply("❌ Failed to add category. Please try again.");
    console.error(error);
  } else {
    await ctx.reply(`✅ Category "${categoryText}" added successfully!`);
  }
});

// Command: /remove
bot.command("remove", async (ctx) => {
  const telegramUserId = ctx.from?.id.toString();
  if (!telegramUserId) return;

  const user = await getOrCreateUser(telegramUserId);
  const customCategories = user?.custom_categories || [];

  if (customCategories.length === 0) {
    await ctx.reply("You don't have any custom categories to remove.");
    return;
  }

  const keyboard = new InlineKeyboard();
  
  customCategories.forEach((cat, index) => {
    keyboard.text(cat, `remove_${index}`).row();
  });
  
  keyboard.text("❌ Cancel", "cancel_remove");

  await ctx.reply("Select a category to remove:", { reply_markup: keyboard });
});

// Handle text messages (expense input)
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  
  // Skip if it's a command
  if (text.startsWith("/")) return;
  
  const parsed = parseExpenseInput(text);
  
  if (!parsed) {
    await ctx.reply(
      "❌ I didn't understand that.\n\n" +
      "Please use format: <amount> <description>\n" +
      "Example: 50 lunch"
    );
    return;
  }

  const telegramUserId = ctx.from?.id.toString() || "";
  
  // Store pending expense in database
  await supabase
    .from("pending_expenses")
    .upsert({
      telegram_user_id: telegramUserId,
      amount: parsed.amount,
      description: parsed.description
    });

  // Ask for category
  const keyboard = await createCategoryKeyboard(telegramUserId);
  await ctx.reply(
    `💵 $${parsed.amount} - ${parsed.description}\n\n` +
    "Select a category:",
    { reply_markup: keyboard }
  );
});

// Handle callback queries
bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  
  if (data.startsWith("cat_")) {
    const categoryIndex = parseInt(data.split("_")[1]);
    const telegramUserId = ctx.from?.id.toString() || "";
    
    // Fetch user and pending expense in parallel
    const [userResult, pendingResult] = await Promise.all([
      getOrCreateUser(telegramUserId),
      supabase
        .from("pending_expenses")
        .select("*")
        .eq("telegram_user_id", telegramUserId)
        .single()
    ]);
    
    const user = userResult;
    const pending = pendingResult.data;
    
    if (!pending) {
      await ctx.answerCallbackQuery("Session expired. Please try again.");
      return;
    }

    // Get category name
    const categories = await getUserCategories(telegramUserId);
    const category = categories[categoryIndex];

    // Save expense and delete pending in parallel
    const [insertResult] = await Promise.all([
      supabase
        .from("expense")
        .insert({
          user_id: user.id,
          amount: pending.amount,
          description: pending.description,
          category: category
        }),
      supabase
        .from("pending_expenses")
        .delete()
        .eq("telegram_user_id", telegramUserId),
      // Clean up old pending expenses in background (fire and forget)
      supabase
        .from("pending_expenses")
        .delete()
        .lt("created_at", new Date(Date.now() - 60 * 60 * 1000).toISOString())
    ]);

    if (insertResult.error) {
      await ctx.editMessageText("❌ Failed to save expense. Please try again.");
      console.error(insertResult.error);
    } else {
      await ctx.editMessageText(
        `✅ Expense saved!\n\n` +
        `💵 $${pending.amount}\n` +
        `📝 ${pending.description}\n` +
        `📁 ${category}`
      );
    }
    
    await ctx.answerCallbackQuery();
  }
  else if (data.startsWith("remove_")) {
    const categoryIndex = parseInt(data.split("_")[1]);
    const telegramUserId = ctx.from?.id.toString() || "";
    
    const user = await getOrCreateUser(telegramUserId);
    const customCategories = user?.custom_categories || [];
    
    if (categoryIndex >= customCategories.length) {
      await ctx.answerCallbackQuery("Invalid category.");
      return;
    }
    
    const categoryToRemove = customCategories[categoryIndex];
    const updatedCustom = customCategories.filter((_, i) => i !== categoryIndex);
    
    const { error } = await supabase
      .from("users")
      .update({ custom_categories: updatedCustom })
      .eq("telegram_user_id", telegramUserId);

    if (error) {
      await ctx.editMessageText("❌ Failed to remove category.");
      console.error(error);
    } else {
      await ctx.editMessageText(`✅ Category "${categoryToRemove}" removed successfully!`);
    }
    
    await ctx.answerCallbackQuery();
  }
  else if (data === "cancel_remove") {
    await ctx.editMessageText("❌ Cancelled.");
    await ctx.answerCallbackQuery();
  }
});

// Error handling
bot.catch((err) => {
  console.error("Bot error:", err);
});

const handleUpdate = webhookCallback(bot, "std/http");

serve(async (req) => {
  try {
    return await handleUpdate(req);
  } catch (err) {
    console.error(err);
    return new Response("Internal Server Error", { status: 500 });
  }
});
