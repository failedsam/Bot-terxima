/**
 * bot.js — The Kanye West of Discord Bots v3.0
 * ─────────────────────────────────────────────
 * ✅ Slash commands + !afk prefix
 * ✅ XP / Leveling with rank card images
 * ✅ Leaderboard image
 * ✅ Set custom level / give XP manually
 * ✅ Reaction roles — unlimited, no message ID, auto-creates roles
 * ✅ Counting game
 * ✅ Welcome / Leave messages
 * ✅ AFK system (!afk + /afk)
 * ✅ DM users through bot + view their replies (/dminbox)
 * ✅ Professional embeds with member PFP
 * ✅ Auto-management (auto-roles, mod log, lock/unlock, slowmode)
 * ✅ Full moderation: kick, ban, unban, timeout, warn, clear
 * ✅ Role management: add, remove, create, delete, color
 * ✅ Fun commands: 8ball, coinflip, roll, joke, roast, rps, compliment, meme
 * ✅ Utility: userinfo, serverinfo, avatar, ping, whois
 */

require("dotenv").config();
const {
  Client, GatewayIntentBits, Partials, EmbedBuilder,
  AttachmentBuilder, REST, Routes, SlashCommandBuilder,
  PermissionFlagsBits, Events, ChannelType,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder,
} = require("discord.js");

// ── Image gen (graceful fallback if canvas not installed) ─────────────────
let ig = null;
try { ig = require("./src/imageGen"); } catch {
  console.warn("⚠️  Images disabled — run: npm install @napi-rs/canvas");
}

const TOKEN     = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID || "";
const PREFIX    = process.env.PREFIX    || "!";

// ═════════════════════════════════════════════════════════════════════════════
//  IN-MEMORY DATA STORE
// ═════════════════════════════════════════════════════════════════════════════
const DB = {
  xp:        new Map(), // `gId-uId` → {xp,level,totalXp,lastMsg}
  afk:       new Map(), // userId   → {reason,time}
  counting:  new Map(), // guildId  → {channelId,count,lastUser,highScore}
  rrPanels:  new Map(), // guildId  → Map(name→{channelId,msgId,roles:Map(emoji→roleId)})
  welcome:   new Map(), // guildId  → {channelId,msg}
  leave:     new Map(), // guildId  → {channelId,msg}
  autoRoles: new Map(), // guildId  → Set(roleId)
  warns:     new Map(), // `gId-uId`→ [reason,...]
  dmInbox:   new Map(), // staffId  → [{fromId,content,ts},...]
  dmLinks:   new Map(), // userId   → staffId
  logCh:     new Map(), // guildId  → channelId
};

// ═════════════════════════════════════════════════════════════════════════════
//  CLIENT
// ═════════════════════════════════════════════════════════════════════════════
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
});

// ═════════════════════════════════════════════════════════════════════════════
//  COLORS
// ═════════════════════════════════════════════════════════════════════════════
const COL = {
  primary: 0x5865F2, success: 0x57F287, error: 0xED4245,
  warn:    0xFEE75C, info:    0x00D4FF, gold:  0xFFD700,
  purple:  0x9B59B6, pink:    0xEB459E, teal:  0x1ABC9C,
};

// ═════════════════════════════════════════════════════════════════════════════
//  EMBED FACTORY — always professional, member PFP in corner
// ═════════════════════════════════════════════════════════════════════════════
function E({ title, desc="", color=COL.primary, user=null, footer=null, fields=[], image=null, thumbnail=null }) {
  const e = new EmbedBuilder().setTitle(title).setDescription(desc).setColor(color).setTimestamp();
  if (user) {
    e.setAuthor({ name: user.displayName ?? user.username, iconURL: user.displayAvatarURL({ dynamic:true }) });
    e.setThumbnail(thumbnail ?? user.displayAvatarURL({ dynamic:true, size:256 }));
  } else if (thumbnail) {
    e.setThumbnail(thumbnail);
  }
  if (footer) e.setFooter({ text: footer });
  if (image)  e.setImage(image);
  for (const f of fields) e.addFields(f);
  return e;
}

const Eok  = (t,d,u)  => E({ title:`✅  ${t}`, desc:d, color:COL.success, user:u });
const Eerr = (d)       => E({ title:"❌  Error", desc:d, color:COL.error });
const Ewrn = (t,d,u)  => E({ title:`⚠️  ${t}`, desc:d, color:COL.warn, user:u });
const Einf = (t,d)     => E({ title:`ℹ️  ${t}`, desc:d, color:COL.info });

// ═════════════════════════════════════════════════════════════════════════════
//  XP ENGINE
// ═════════════════════════════════════════════════════════════════════════════
const xpKey    = (g,u) => `${g}-${u}`;
const xpNeeded = lv    => 5*lv*lv + 50*lv + 100;
const getXp    = (g,u) => DB.xp.get(xpKey(g,u)) ?? { xp:0, level:1, totalXp:0, lastMsg:0 };

function addXp(gId, uId, amt) {
  const k=xpKey(gId,uId), d=getXp(gId,uId);
  d.xp+=amt; d.totalXp=(d.totalXp||0)+amt;
  let leveled=false;
  while(d.xp >= xpNeeded(d.level)) { d.xp-=xpNeeded(d.level); d.level++; leveled=true; }
  DB.xp.set(k,d);
  return { d, leveled };
}

function forceLevel(gId, uId, level) {
  const k=xpKey(gId,uId), d=getXp(gId,uId);
  d.level=Math.max(1,level); d.xp=0;
  DB.xp.set(k,d);
}

function getRank(gId, uId) {
  const list = [...DB.xp.entries()]
    .filter(([k])=>k.startsWith(`${gId}-`))
    .sort((a,b)=>b[1].level-a[1].level||b[1].xp-a[1].xp);
  const i = list.findIndex(([k])=>k===xpKey(gId,uId));
  return i===-1 ? list.length+1 : i+1;
}

// ═════════════════════════════════════════════════════════════════════════════
//  MOD LOG HELPER
// ═════════════════════════════════════════════════════════════════════════════
async function modlog(guild, embed) {
  const cid = DB.logCh.get(guild.id);
  if (!cid) return;
  const ch = guild.channels.cache.get(cid);
  if (ch) ch.send({ embeds:[embed] }).catch(()=>{});
}

// ═════════════════════════════════════════════════════════════════════════════
//  REPLY HELPER (works for interactions + messages)
// ═════════════════════════════════════════════════════════════════════════════
async function reply(ctx, payload, ephemeral=false) {
  if (ctx.isCommand?.() || ctx.isChatInputCommand?.()) {
    if (ctx.deferred || ctx.replied) return ctx.followUp({ ...payload, ephemeral });
    return ctx.reply({ ...payload, ephemeral });
  }
  return ctx.channel?.send(payload) ?? ctx.send(payload);
}

// ═════════════════════════════════════════════════════════════════════════════
//  SLASH COMMAND DEFINITIONS
// ═════════════════════════════════════════════════════════════════════════════
const commands = [
  // ── Help ──────────────────────────────────────────────────────────────
  new SlashCommandBuilder().setName("help").setDescription("Show all commands"),

  // ── Utility ───────────────────────────────────────────────────────────
  new SlashCommandBuilder().setName("ping").setDescription("Check bot latency"),
  new SlashCommandBuilder().setName("userinfo")
    .setDescription("View info about a user")
    .addUserOption(o=>o.setName("user").setDescription("User to check")),
  new SlashCommandBuilder().setName("serverinfo").setDescription("View server information"),
  new SlashCommandBuilder().setName("avatar")
    .setDescription("Get a user's avatar")
    .addUserOption(o=>o.setName("user").setDescription("User")),
  new SlashCommandBuilder().setName("whois")
    .setDescription("Look up any Discord user by ID")
    .addStringOption(o=>o.setName("id").setDescription("Discord user ID").setRequired(true)),

  // ── AFK ───────────────────────────────────────────────────────────────
  new SlashCommandBuilder().setName("afk")
    .setDescription("Set your AFK status")
    .addStringOption(o=>o.setName("reason").setDescription("Why are you AFK?")),

  // ── Moderation ────────────────────────────────────────────────────────
  new SlashCommandBuilder().setName("kick")
    .setDescription("Kick a member")
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
    .addUserOption(o=>o.setName("user").setDescription("Member to kick").setRequired(true))
    .addStringOption(o=>o.setName("reason").setDescription("Reason")),
  new SlashCommandBuilder().setName("ban")
    .setDescription("Ban a member")
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addUserOption(o=>o.setName("user").setDescription("Member to ban").setRequired(true))
    .addStringOption(o=>o.setName("reason").setDescription("Reason"))
    .addIntegerOption(o=>o.setName("days").setDescription("Delete messages days (0-7)").setMinValue(0).setMaxValue(7)),
  new SlashCommandBuilder().setName("unban")
    .setDescription("Unban a user by ID")
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addStringOption(o=>o.setName("id").setDescription("User ID").setRequired(true)),
  new SlashCommandBuilder().setName("timeout")
    .setDescription("Timeout a member")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o=>o.setName("user").setDescription("Member").setRequired(true))
    .addIntegerOption(o=>o.setName("minutes").setDescription("Duration in minutes (0 = remove)").setRequired(true).setMinValue(0).setMaxValue(40320))
    .addStringOption(o=>o.setName("reason").setDescription("Reason")),
  new SlashCommandBuilder().setName("warn")
    .setDescription("Warn a member")
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
    .addUserOption(o=>o.setName("user").setDescription("Member").setRequired(true))
    .addStringOption(o=>o.setName("reason").setDescription("Reason")),
  new SlashCommandBuilder().setName("warnings")
    .setDescription("View a member's warnings")
    .addUserOption(o=>o.setName("user").setDescription("Member").setRequired(true)),
  new SlashCommandBuilder().setName("clearwarns")
    .setDescription("Clear all warnings for a member")
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
    .addUserOption(o=>o.setName("user").setDescription("Member").setRequired(true)),
  new SlashCommandBuilder().setName("clear")
    .setDescription("Bulk delete messages")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addIntegerOption(o=>o.setName("amount").setDescription("1-100").setRequired(true).setMinValue(1).setMaxValue(100)),
  new SlashCommandBuilder().setName("lock")
    .setDescription("Lock a channel")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addChannelOption(o=>o.setName("channel").setDescription("Channel (blank = current)")),
  new SlashCommandBuilder().setName("unlock")
    .setDescription("Unlock a channel")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addChannelOption(o=>o.setName("channel").setDescription("Channel (blank = current)")),
  new SlashCommandBuilder().setName("slowmode")
    .setDescription("Set channel slowmode")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addIntegerOption(o=>o.setName("seconds").setDescription("0 to disable").setRequired(true).setMinValue(0).setMaxValue(21600))
    .addChannelOption(o=>o.setName("channel").setDescription("Channel")),

  // ── Announce & DM ─────────────────────────────────────────────────────
  new SlashCommandBuilder().setName("announce")
    .setDescription("Post anonymous announcement")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addChannelOption(o=>o.setName("channel").setDescription("Target channel").setRequired(true))
    .addStringOption(o=>o.setName("message").setDescription("Announcement text").setRequired(true))
    .addStringOption(o=>o.setName("title").setDescription("Custom title")),
  new SlashCommandBuilder().setName("dm")
    .setDescription("Send a DM to a user via bot")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addUserOption(o=>o.setName("user").setDescription("User to DM").setRequired(true))
    .addStringOption(o=>o.setName("message").setDescription("Message content").setRequired(true)),
  new SlashCommandBuilder().setName("dminbox")
    .setDescription("View replies from users you DM'd")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  // ── Roles ─────────────────────────────────────────────────────────────
  new SlashCommandBuilder().setName("role")
    .setDescription("Role management")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addSubcommand(s=>s.setName("add").setDescription("Give role to member")
      .addUserOption(o=>o.setName("user").setDescription("Member").setRequired(true))
      .addRoleOption(o=>o.setName("role").setDescription("Role").setRequired(true)))
    .addSubcommand(s=>s.setName("remove").setDescription("Remove role from member")
      .addUserOption(o=>o.setName("user").setDescription("Member").setRequired(true))
      .addRoleOption(o=>o.setName("role").setDescription("Role").setRequired(true)))
    .addSubcommand(s=>s.setName("create").setDescription("Create a new role")
      .addStringOption(o=>o.setName("name").setDescription("Role name").setRequired(true))
      .addStringOption(o=>o.setName("color").setDescription("Hex color e.g. #5865F2")))
    .addSubcommand(s=>s.setName("delete").setDescription("Delete a role")
      .addRoleOption(o=>o.setName("role").setDescription("Role to delete").setRequired(true)))
    .addSubcommand(s=>s.setName("info").setDescription("View role info")
      .addRoleOption(o=>o.setName("role").setDescription("Role").setRequired(true))),

  // ── Auto-role ─────────────────────────────────────────────────────────
  new SlashCommandBuilder().setName("autorole")
    .setDescription("Auto-assign roles on member join")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(s=>s.setName("add").setDescription("Add auto-role")
      .addRoleOption(o=>o.setName("role").setDescription("Role").setRequired(true)))
    .addSubcommand(s=>s.setName("remove").setDescription("Remove auto-role")
      .addRoleOption(o=>o.setName("role").setDescription("Role").setRequired(true)))
    .addSubcommand(s=>s.setName("list").setDescription("List auto-roles")),

  // ── Reaction roles ────────────────────────────────────────────────────
  new SlashCommandBuilder().setName("rr")
    .setDescription("Reaction role panels")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addSubcommand(s=>s.setName("create").setDescription("Create a new reaction role panel")
      .addChannelOption(o=>o.setName("channel").setDescription("Channel for the panel").setRequired(true))
      .addStringOption(o=>o.setName("name").setDescription("Panel name").setRequired(true))
      .addStringOption(o=>o.setName("title").setDescription("Embed title"))
      .addStringOption(o=>o.setName("description").setDescription("Embed description")))
    .addSubcommand(s=>s.setName("add").setDescription("Add emoji→role to a panel (auto-creates role if needed)")
      .addStringOption(o=>o.setName("panel").setDescription("Panel name").setRequired(true))
      .addStringOption(o=>o.setName("emoji").setDescription("Emoji").setRequired(true))
      .addStringOption(o=>o.setName("role").setDescription("Role name or @mention (created if missing)").setRequired(true)))
    .addSubcommand(s=>s.setName("remove").setDescription("Remove emoji from panel")
      .addStringOption(o=>o.setName("panel").setDescription("Panel name").setRequired(true))
      .addStringOption(o=>o.setName("emoji").setDescription("Emoji to remove").setRequired(true)))
    .addSubcommand(s=>s.setName("list").setDescription("List all panels")),

  // ── Welcome / Leave ───────────────────────────────────────────────────
  new SlashCommandBuilder().setName("setwelcome")
    .setDescription("Set welcome channel and message")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption(o=>o.setName("channel").setDescription("Welcome channel").setRequired(true))
    .addStringOption(o=>o.setName("message").setDescription("Message ({user},{server},{count})")),
  new SlashCommandBuilder().setName("setleave")
    .setDescription("Set leave channel and message")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption(o=>o.setName("channel").setDescription("Leave channel").setRequired(true))
    .addStringOption(o=>o.setName("message").setDescription("Message ({user},{server})")),

  // ── Counting ──────────────────────────────────────────────────────────
  new SlashCommandBuilder().setName("counting")
    .setDescription("Counting game")
    .addSubcommand(s=>s.setName("setup").setDescription("Set counting channel")
      .addChannelOption(o=>o.setName("channel").setDescription("Channel").setRequired(true)))
    .addSubcommand(s=>s.setName("reset").setDescription("Reset count to 0"))
    .addSubcommand(s=>s.setName("score").setDescription("Show current count & high score")),

  // ── Leveling ──────────────────────────────────────────────────────────
  new SlashCommandBuilder().setName("rank")
    .setDescription("View XP rank card")
    .addUserOption(o=>o.setName("user").setDescription("User (blank = you)")),
  new SlashCommandBuilder().setName("leaderboard")
    .setDescription("View XP leaderboard image"),
  new SlashCommandBuilder().setName("setlevel")
    .setDescription("Set a member's level")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption(o=>o.setName("user").setDescription("Member").setRequired(true))
    .addIntegerOption(o=>o.setName("level").setDescription("Target level").setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName("givexp")
    .setDescription("Manually give XP to a member")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption(o=>o.setName("user").setDescription("Member").setRequired(true))
    .addIntegerOption(o=>o.setName("amount").setDescription("XP amount").setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName("resetxp")
    .setDescription("Reset a member's XP and level")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption(o=>o.setName("user").setDescription("Member").setRequired(true)),

  // ── Auto-management ───────────────────────────────────────────────────
  new SlashCommandBuilder().setName("setlogchannel")
    .setDescription("Set mod-log channel")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption(o=>o.setName("channel").setDescription("Log channel").setRequired(true)),

  // ── Fun ───────────────────────────────────────────────────────────────
  new SlashCommandBuilder().setName("8ball")
    .setDescription("Ask the magic 8-ball")
    .addStringOption(o=>o.setName("question").setDescription("Your question").setRequired(true)),
  new SlashCommandBuilder().setName("coinflip").setDescription("Flip a coin"),
  new SlashCommandBuilder().setName("roll")
    .setDescription("Roll a dice")
    .addIntegerOption(o=>o.setName("sides").setDescription("Sides (default 6)").setMinValue(2)),
  new SlashCommandBuilder().setName("joke").setDescription("Get a random joke"),
  new SlashCommandBuilder().setName("roast")
    .setDescription("Roast someone 🔥")
    .addUserOption(o=>o.setName("user").setDescription("Who to roast").setRequired(true)),
  new SlashCommandBuilder().setName("compliment")
    .setDescription("Compliment someone 💖")
    .addUserOption(o=>o.setName("user").setDescription("Who to compliment").setRequired(true)),
  new SlashCommandBuilder().setName("rps")
    .setDescription("Rock Paper Scissors vs bot")
    .addStringOption(o=>o.setName("choice").setDescription("Your move").setRequired(true)
      .addChoices(
        { name:"🪨 Rock",     value:"rock"     },
        { name:"📄 Paper",   value:"paper"    },
        { name:"✂️ Scissors", value:"scissors" }
      )),
  new SlashCommandBuilder().setName("meme").setDescription("Get a random meme"),
  new SlashCommandBuilder().setName("ship")
    .setDescription("Ship two users 💕")
    .addUserOption(o=>o.setName("user1").setDescription("First user").setRequired(true))
    .addUserOption(o=>o.setName("user2").setDescription("Second user")),
  new SlashCommandBuilder().setName("pp")
    .setDescription("pp size check 😂")
    .addUserOption(o=>o.setName("user").setDescription("User")),
].map(c => c.toJSON());

// ═════════════════════════════════════════════════════════════════════════════
//  REGISTER SLASH COMMANDS
// ═════════════════════════════════════════════════════════════════════════════
async function registerCommands() {
  try {
    const rest = new REST({ version:"10" }).setToken(TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log(`✅  ${commands.length} slash commands registered globally`);
  } catch(e) {
    console.error("❌  Failed to register commands:", e.message);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  READY
// ═════════════════════════════════════════════════════════════════════════════
client.once(Events.ClientReady, async () => {
  console.log(`\n🚀  ${client.user.tag} is LIVE — The Kanye West of Bots`);
  client.user.setActivity(`/help | ${PREFIX}afk | v3.0`, { type: 3 });
  await registerCommands();
});

// ═════════════════════════════════════════════════════════════════════════════
//  MESSAGE CREATE — XP, AFK, counting, !afk
// ═════════════════════════════════════════════════════════════════════════════
client.on(Events.MessageCreate, async (msg) => {
  // Capture DM replies
  if (!msg.guild && !msg.author.bot) {
    const staffId = DB.dmLinks.get(msg.author.id);
    if (staffId) {
      const inbox = DB.dmInbox.get(staffId) || [];
      inbox.push({ fromId: msg.author.id, content: msg.content, ts: Date.now() });
      DB.dmInbox.set(staffId, inbox);
    }
    return;
  }
  if (!msg.guild || msg.author.bot) return;

  const gId     = msg.guild.id;
  const uId     = msg.author.id;
  const content = msg.content.trim();

  // ── XP ──────────────────────────────────────────────────────────────
  const d = getXp(gId, uId);
  if (Date.now() - d.lastMsg > 60_000) {
    d.lastMsg = Date.now();
    DB.xp.set(xpKey(gId, uId), d);
    const { d: nd, leveled } = addXp(gId, uId, Math.floor(Math.random()*15)+10);
    if (leveled) {
      const rank  = getRank(gId, uId);
      const avURL = msg.author.displayAvatarURL({ extension:"png", size:256 });
      const lvlE  = E({ title:"🎉  Level Up!", desc:`${msg.author} reached **Level ${nd.level}**! 🎊`,
        color:COL.gold, user:msg.author });
      if (ig) {
        try {
          const buf = await ig.makeRankCard({
            username:msg.author.displayName, discriminator:msg.author.discriminator,
            level:nd.level, xp:nd.xp, xpNeeded:xpNeeded(nd.level), rank, avatarURL:avURL,
          });
          lvlE.setImage("attachment://rank.png");
          await msg.channel.send({ embeds:[lvlE], files:[new AttachmentBuilder(buf,{name:"rank.png"})] });
        } catch(ex) {
          console.error("[LevelUp img]", ex.message);
          await msg.channel.send({ embeds:[lvlE] });
        }
      } else {
        await msg.channel.send({ embeds:[lvlE] });
      }
    }
  }

  // ── AFK mention ─────────────────────────────────────────────────────
  for (const [,u] of msg.mentions.users) {
    if (DB.afk.has(u.id)) {
      const a = DB.afk.get(u.id);
      const ago = Math.floor((Date.now()-a.time)/1000);
      const e = E({ title:"💤  User is AFK", desc:`${u} is currently AFK.`,
        color:COL.info, thumbnail:u.displayAvatarURL({dynamic:true}),
        fields:[{name:"Reason",value:a.reason,inline:true},{name:"Away for",value:`${ago}s`,inline:true}]});
      await msg.channel.send({ embeds:[e] });
    }
  }

  // ── AFK return ───────────────────────────────────────────────────────
  if (DB.afk.has(uId) && !content.toLowerCase().startsWith(`${PREFIX}afk`)) {
    DB.afk.delete(uId);
    const m = await msg.channel.send({ embeds:[Eok("Welcome Back!",`${msg.author}, AFK removed.`)] });
    setTimeout(()=>m.delete().catch(()=>{}), 5000);
  }

  // ── Counting ─────────────────────────────────────────────────────────
  const cnt = DB.counting.get(gId);
  if (cnt && msg.channel.id === cnt.channelId) {
    const num = parseInt(content, 10);
    const exp = cnt.count + 1;
    const dbl = cnt.lastUser === uId;
    if (isNaN(num) || num !== exp || dbl) {
      await msg.react("❌").catch(()=>{});
      const reason = dbl ? "You can't count twice in a row!" : `Wrong number! Expected **${exp}**.`;
      const e = E({title:"❌  Counting Ruined!",desc:reason,color:COL.error,
        footer:`High Score: ${cnt.highScore||0} | Reset to 0`});
      cnt.count=0; cnt.lastUser=null; DB.counting.set(gId,cnt);
      return msg.channel.send({ embeds:[e] });
    }
    await msg.react("✅").catch(()=>{});
    cnt.count++; cnt.lastUser=uId;
    if (cnt.count>(cnt.highScore||0)) cnt.highScore=cnt.count;
    DB.counting.set(gId,cnt);
    return;
  }

  // ── !afk prefix ──────────────────────────────────────────────────────
  if (content.toLowerCase().startsWith(`${PREFIX}afk`)) {
    const reason = content.slice(PREFIX.length+3).trim() || "No reason provided";
    DB.afk.set(uId, { reason, time:Date.now() });
    return msg.channel.send({ embeds:[E({title:"💤  AFK Set",
      desc:`${msg.author} is now AFK.`, color:COL.info, user:msg.author,
      fields:[{name:"Reason",value:reason}]})] });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
//  MEMBER JOIN — autoroles + welcome
// ═════════════════════════════════════════════════════════════════════════════
client.on(Events.GuildMemberAdd, async (member) => {
  for (const rid of DB.autoRoles.get(member.guild.id) || []) {
    const role = member.guild.roles.cache.get(rid);
    if (role) member.roles.add(role).catch(()=>{});
  }
  const cfg = DB.welcome.get(member.guild.id);
  if (!cfg) return;
  const ch = member.guild.channels.cache.get(cfg.channelId);
  if (!ch) return;
  const text = cfg.msg
    .replace("{user}", member.toString())
    .replace("{server}", member.guild.name)
    .replace("{count}", member.guild.memberCount);
  const e = E({ title:"👋  Welcome!", desc:text, color:COL.success, user:member.user,
    fields:[
      {name:"Member #",    value:`${member.guild.memberCount}`, inline:true},
      {name:"Account Age", value:`<t:${Math.floor(member.user.createdTimestamp/1000)}:R>`, inline:true},
    ]});
  ch.send({ embeds:[e] });
});

client.on(Events.GuildMemberRemove, async (member) => {
  const cfg = DB.leave.get(member.guild.id);
  if (!cfg) return;
  const ch = member.guild.channels.cache.get(cfg.channelId);
  if (!ch) return;
  const text = cfg.msg
    .replace("{user}", member.user.tag)
    .replace("{server}", member.guild.name);
  ch.send({ embeds:[E({title:"👋  Goodbye!",desc:text,color:COL.error,user:member.user})] });
});

// ═════════════════════════════════════════════════════════════════════════════
//  REACTION ROLES
// ═════════════════════════════════════════════════════════════════════════════
async function handleRR(payload, add) {
  if (payload.userId === client.user.id) return;
  const guild = client.guilds.cache.get(payload.guildId);
  if (!guild) return;
  const panels = DB.rrPanels.get(payload.guildId);
  if (!panels) return;
  for (const [, panel] of panels) {
    if (panel.msgId !== payload.messageId) continue;
    const roleId = panel.roles.get(String(payload.emoji.name ?? payload.emoji.id));
    if (!roleId) continue;
    const member = guild.members.cache.get(payload.userId) || await guild.members.fetch(payload.userId).catch(()=>null);
    const role   = guild.roles.cache.get(roleId);
    if (member && role) {
      if (add) member.roles.add(role).catch(()=>{});
      else     member.roles.remove(role).catch(()=>{});
    }
  }
}
client.on(Events.MessageReactionAdd,    (r,u) => handleRR(r, true));
client.on(Events.MessageReactionRemove, (r,u) => handleRR(r, false));
client.on(Events.RawMessageReactionAdd,    p => handleRR(p, true));
client.on(Events.RawMessageReactionRemove, p => handleRR(p, false));

// ═════════════════════════════════════════════════════════════════════════════
//  FUN DATA
// ═════════════════════════════════════════════════════════════════════════════
const EIGHTBALL = ["It is certain.","Without a doubt.","Yes, definitely!","Most likely.","Outlook good.",
  "Signs point to yes.","Ask again later.","Cannot predict now.","Concentrate and ask again.",
  "Reply hazy, try again.","Don't count on it.","My reply is no.","Outlook not so good.","Very doubtful.","Absolutely not!"];
const JOKES = [
  "Why do programmers prefer dark mode? Because light attracts bugs! 🐛",
  "I told my wife she should embrace her mistakes. She gave me a hug.",
  "Why did the scarecrow win an award? Outstanding in his field!",
  "I asked the librarian if they had books about paranoia. She whispered: 'They're right behind you!'",
  "Parallel lines have so much in common... it's a shame they'll never meet.",
  "I used to hate facial hair, but then it grew on me.",
  "Why don't scientists trust atoms? Because they make up everything!",
  "A skeleton walks into a bar. Orders a beer and a mop.",
];
const ROASTS = [
  "You're the reason the gene pool needs a lifeguard. 🏊",
  "I'd agree with you but then we'd both be wrong.",
  "You're not stupid, you just have bad luck thinking.",
  "You bring joy to every room you leave.",
  "You're proof that evolution CAN go in reverse.",
  "I've seen better arguments in a kindergarten class.",
  "If brains were dynamite, you couldn't blow your hat off.",
];
const COMPLIMENTS = [
  "You light up every room you walk into! ✨",
  "Your smile could end world wars! 😊",
  "You're basically a human version of a good day.",
  "People like you are the reason I believe in good things.",
  "You're the human equivalent of a perfect playlist. 🎵",
  "The world is genuinely better with you in it. 💙",
  "You could make a rainy day feel like sunshine! ☀️",
];
const MEMES = [
  "This is fine. 🔥","One does not simply walk into Mordor.","I am inevitable.",
  "Why so serious?","We're no strangers to love 🎵","It's over 9000!",
  "You shall not pass!","May the force be with you.","I am speed. ⚡",
  "He's beginning to believe.","Why is it always in the last place you look?",
];

// ═════════════════════════════════════════════════════════════════════════════
//  INTERACTION HANDLER
// ═════════════════════════════════════════════════════════════════════════════
client.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand()) return;
  const { commandName: cmd, guild, member, user } = i;

  // defer helper
  const defer = (ephem=false) => i.deferReply({ ephemeral:ephem });

  try {
    // ── HELP ──────────────────────────────────────────────────────────
    if (cmd === "help") {
      const e = new EmbedBuilder()
        .setTitle("📖  The Kanye West of Bots — All Commands")
        .setColor(COL.primary)
        .setThumbnail(client.user.displayAvatarURL())
        .setTimestamp()
        .addFields(
          { name:"🛡️  Moderation",     value:"`/kick` `/ban` `/unban` `/timeout` `/warn` `/warnings` `/clearwarns` `/clear` `/lock` `/unlock` `/slowmode`", inline:false },
          { name:"📢  Announce & DM",  value:"`/announce` — Anonymous embed\n`/dm` — DM user via bot\n`/dminbox` — See their replies", inline:false },
          { name:"🎭  Reaction Roles", value:"`/rr create` — New panel\n`/rr add` — Add emoji→role (auto-creates role!)\n`/rr remove` — Remove entry\n`/rr list` — View panels", inline:false },
          { name:"🔧  Roles",          value:"`/role add/remove/create/delete/info`\n`/autorole add/remove/list`", inline:false },
          { name:"👋  Welcome/Leave",  value:"`/setwelcome` `/setleave`\nVariables: `{user}` `{server}` `{count}`", inline:false },
          { name:"🔢  Counting",       value:"`/counting setup/reset/score`", inline:false },
          { name:"💤  AFK",            value:`\`${PREFIX}afk [reason]\` or \`/afk\``, inline:false },
          { name:"📊  Leveling",       value:"`/rank` `/leaderboard` `/setlevel` `/givexp` `/resetxp`", inline:false },
          { name:"🤖  Auto-Manage",    value:"`/setlogchannel` `/lock` `/unlock` `/slowmode` `/autorole`", inline:false },
          { name:"🎉  Fun",            value:"`/8ball` `/coinflip` `/roll` `/joke` `/roast` `/compliment` `/rps` `/meme` `/ship` `/pp`", inline:false },
          { name:"ℹ️  Utility",        value:"`/userinfo` `/serverinfo` `/avatar` `/ping` `/whois`", inline:false },
        )
        .setFooter({ text:`Prefix: ${PREFIX}  •  Kanye Bot v3.0` });
      return i.reply({ embeds:[e] });
    }

    // ── PING ──────────────────────────────────────────────────────────
    if (cmd === "ping") {
      return i.reply({ embeds:[Einf("🏓  Pong!", `Latency: **${Date.now()-i.createdTimestamp}ms** | API: **${client.ws.ping}ms**`)] });
    }

    // ── AFK ───────────────────────────────────────────────────────────
    if (cmd === "afk") {
      const reason = i.options.getString("reason") || "No reason provided";
      DB.afk.set(user.id, { reason, time:Date.now() });
      return i.reply({ embeds:[E({title:"💤  AFK Set",desc:`${user} is now AFK.`,
        color:COL.info,user,fields:[{name:"Reason",value:reason}]})] });
    }

    // ── KICK ──────────────────────────────────────────────────────────
    if (cmd === "kick") {
      const target = i.options.getMember("user");
      const reason = i.options.getString("reason") || "No reason provided";
      if (!target?.kickable) return i.reply({ embeds:[Eerr("I can't kick that member.")], ephemeral:true });
      await target.kick(reason);
      const e = E({title:"👢  Member Kicked",desc:`${target} has been kicked from the server.`,
        color:COL.warn, user:target.user,
        fields:[{name:"Reason",value:reason,inline:true},{name:"Moderator",value:`${user}`,inline:true}]});
      await modlog(guild, e);
      return i.reply({ embeds:[e] });
    }

    // ── BAN ───────────────────────────────────────────────────────────
    if (cmd === "ban") {
      const target = i.options.getMember("user") ?? i.options.getUser("user");
      const reason = i.options.getString("reason") || "No reason provided";
      const days   = i.options.getInteger("days") || 0;
      const isMem  = target?.bannable !== undefined;
      if (isMem && !target.bannable) return i.reply({ embeds:[Eerr("I can't ban that member.")], ephemeral:true });
      await guild.bans.create(isMem ? target.id : target.id, { reason, deleteMessageDays:days });
      const u2 = isMem ? target.user : target;
      const e = E({title:"🔨  Member Banned",desc:`**${u2.tag}** has been banned.`,
        color:COL.error, user:u2,
        fields:[{name:"Reason",value:reason,inline:true},{name:"Moderator",value:`${user}`,inline:true},
                {name:"Msg Delete",value:`${days} day(s)`,inline:true}]});
      await modlog(guild, e);
      return i.reply({ embeds:[e] });
    }

    // ── UNBAN ─────────────────────────────────────────────────────────
    if (cmd === "unban") {
      const id = i.options.getString("id");
      try {
        await guild.bans.remove(id);
        return i.reply({ embeds:[Eok("Unbanned",`User \`${id}\` has been unbanned.`)] });
      } catch {
        return i.reply({ embeds:[Eerr("Couldn't find that ban.")], ephemeral:true });
      }
    }

    // ── TIMEOUT ───────────────────────────────────────────────────────
    if (cmd === "timeout") {
      const target  = i.options.getMember("user");
      const minutes = i.options.getInteger("minutes");
      const reason  = i.options.getString("reason") || "No reason provided";
      if (!target) return i.reply({ embeds:[Eerr("Member not found.")], ephemeral:true });
      if (minutes === 0) {
        await target.timeout(null);
        return i.reply({ embeds:[Eok("Timeout Removed",`${target}'s timeout has been removed.`,target.user)] });
      }
      await target.timeout(minutes * 60_000, reason);
      const e = E({title:"⏱️  Member Timed Out",desc:`${target} has been timed out for **${minutes} minute(s)**.`,
        color:COL.warn, user:target.user,
        fields:[{name:"Reason",value:reason,inline:true},{name:"Moderator",value:`${user}`,inline:true},
                {name:"Duration",value:`${minutes}m`,inline:true}]});
      await modlog(guild, e);
      // DM the user
      target.user.send({ embeds:[E({title:"⏱️  You Were Timed Out",
        desc:`You were timed out in **${guild.name}** for **${minutes} minute(s)**.`,
        color:COL.warn, fields:[{name:"Reason",value:reason}]})] }).catch(()=>{});
      return i.reply({ embeds:[e] });
    }

    // ── WARN ──────────────────────────────────────────────────────────
    if (cmd === "warn") {
      const target = i.options.getMember("user");
      const reason = i.options.getString("reason") || "No reason provided";
      if (!target) return i.reply({ embeds:[Eerr("Member not found.")], ephemeral:true });
      const key = `${guild.id}-${target.id}`;
      const wlist = DB.warns.get(key) || [];
      wlist.push(reason);
      DB.warns.set(key, wlist);
      const e = E({title:"⚠️  Member Warned",desc:`${target} has been warned.`,
        color:COL.warn, user:target.user,
        fields:[{name:"Reason",value:reason,inline:true},{name:"Moderator",value:`${user}`,inline:true},
                {name:"Total Warns",value:`${wlist.length}`,inline:true}]});
      target.user.send({ embeds:[E({title:"⚠️  You Were Warned",
        desc:`You were warned in **${guild.name}**.`,color:COL.warn,
        fields:[{name:"Reason",value:reason},{name:"Total Warnings",value:`${wlist.length}`}]})] }).catch(()=>{});
      await modlog(guild, e);
      return i.reply({ embeds:[e] });
    }

    // ── WARNINGS ──────────────────────────────────────────────────────
    if (cmd === "warnings") {
      const target = i.options.getMember("user");
      const key    = `${guild.id}-${target.id}`;
      const wlist  = DB.warns.get(key) || [];
      if (!wlist.length) return i.reply({ embeds:[Eok("No Warnings",`${target} has no warnings.`,target.user)], ephemeral:true });
      const desc = wlist.map((r,n)=>`**${n+1}.** ${r}`).join("\n");
      return i.reply({ embeds:[E({title:`⚠️  Warnings for ${target.displayName}`,desc,color:COL.warn,user:target.user})] });
    }

    // ── CLEARWARNS ────────────────────────────────────────────────────
    if (cmd === "clearwarns") {
      const target = i.options.getMember("user");
      DB.warns.delete(`${guild.id}-${target.id}`);
      return i.reply({ embeds:[Eok("Warnings Cleared",`All warnings cleared for ${target}.`,target.user)] });
    }

    // ── CLEAR ─────────────────────────────────────────────────────────
    if (cmd === "clear") {
      const amount = i.options.getInteger("amount");
      await defer(true);
      const deleted = await i.channel.bulkDelete(amount, true).catch(()=>null);
      return i.editReply({ embeds:[Eok("Cleared",`Deleted **${deleted?.size ?? 0}** messages.`)] });
    }

    // ── LOCK ──────────────────────────────────────────────────────────
    if (cmd === "lock") {
      const ch = i.options.getChannel("channel") ?? i.channel;
      await ch.permissionOverwrites.edit(guild.roles.everyone, { SendMessages:false });
      return i.reply({ embeds:[Eok("🔒  Locked",`${ch} has been locked.`)] });
    }

    // ── UNLOCK ────────────────────────────────────────────────────────
    if (cmd === "unlock") {
      const ch = i.options.getChannel("channel") ?? i.channel;
      await ch.permissionOverwrites.edit(guild.roles.everyone, { SendMessages:null });
      return i.reply({ embeds:[Eok("🔓  Unlocked",`${ch} has been unlocked.`)] });
    }

    // ── SLOWMODE ──────────────────────────────────────────────────────
    if (cmd === "slowmode") {
      const secs = i.options.getInteger("seconds");
      const ch   = i.options.getChannel("channel") ?? i.channel;
      await ch.setRateLimitPerUser(secs);
      const msg2 = secs === 0 ? `Slowmode disabled in ${ch}.` : `Slowmode set to **${secs}s** in ${ch}.`;
      return i.reply({ embeds:[Eok("Slowmode",msg2)] });
    }

    // ── ANNOUNCE ──────────────────────────────────────────────────────
    if (cmd === "announce") {
      const ch    = i.options.getChannel("channel");
      const text  = i.options.getString("message");
      const title = i.options.getString("title") || "📢  Announcement";
      const e = new EmbedBuilder().setTitle(title).setDescription(text)
        .setColor(COL.purple).setTimestamp()
        .setFooter({ text:guild.name, iconURL:guild.iconURL()??undefined });
      await ch.send({ embeds:[e] });
      return i.reply({ embeds:[Eok("Sent",`Announcement posted in ${ch}.`)], ephemeral:true });
    }

    // ── DM ────────────────────────────────────────────────────────────
    if (cmd === "dm") {
      const target = i.options.getUser("user");
      const text   = i.options.getString("message");
      const e = new EmbedBuilder()
        .setTitle(`📬  Message from ${guild.name}`)
        .setDescription(text).setColor(COL.primary).setTimestamp()
        .setFooter({ text:"Reply to this DM — staff will see your reply via /dminbox" });
      try {
        await target.send({ embeds:[e] });
        DB.dmLinks.set(target.id, user.id);
        return i.reply({ embeds:[Eok("DM Sent",`Message sent to ${target}. Replies will appear in \`/dminbox\`.`)], ephemeral:true });
      } catch {
        return i.reply({ embeds:[Eerr("Couldn't DM that user (they may have DMs off).")], ephemeral:true });
      }
    }

    // ── DMINBOX ───────────────────────────────────────────────────────
    if (cmd === "dminbox") {
      const inbox = DB.dmInbox.get(user.id) || [];
      if (!inbox.length) return i.reply({ embeds:[Einf("DM Inbox","No replies yet.")], ephemeral:true });
      const desc = inbox.slice(-15).map(m=>`**From <@${m.fromId}>** <t:${Math.floor(m.ts/1000)}:R>\n> ${m.content}`).join("\n\n");
      return i.reply({ embeds:[E({title:"📬  DM Inbox",desc,color:COL.primary})], ephemeral:true });
    }

    // ── ROLE ──────────────────────────────────────────────────────────
    if (cmd === "role") {
      const sub = i.options.getSubcommand();
      if (sub === "add") {
        const target = i.options.getMember("user");
        const role   = i.options.getRole("role");
        await target.roles.add(role);
        return i.reply({ embeds:[Eok("Role Added",`Gave **${role.name}** to ${target}.`,target.user)] });
      }
      if (sub === "remove") {
        const target = i.options.getMember("user");
        const role   = i.options.getRole("role");
        await target.roles.remove(role);
        return i.reply({ embeds:[Eok("Role Removed",`Removed **${role.name}** from ${target}.`,target.user)] });
      }
      if (sub === "create") {
        const name  = i.options.getString("name");
        const color = i.options.getString("color")?.replace("#","");
        const newR  = await guild.roles.create({ name, color: color ? parseInt(color,16) : undefined });
        return i.reply({ embeds:[Eok("Role Created",`Created **${newR.name}** (${newR})`)] });
      }
      if (sub === "delete") {
        const role = i.options.getRole("role");
        await role.delete();
        return i.reply({ embeds:[Eok("Role Deleted",`Role **${role.name}** deleted.`)] });
      }
      if (sub === "info") {
        const role = i.options.getRole("role");
        const e = E({title:`🎭  Role: ${role.name}`,desc:"",color:role.color||COL.primary,
          fields:[
            {name:"ID",      value:role.id,                                           inline:true},
            {name:"Color",   value:`#${role.color.toString(16).padStart(6,"0")}`,     inline:true},
            {name:"Members", value:`${role.members.size}`,                            inline:true},
            {name:"Position",value:`${role.position}`,                               inline:true},
            {name:"Hoisted", value:role.hoist?"Yes":"No",                            inline:true},
            {name:"Mentionable",value:role.mentionable?"Yes":"No",                   inline:true},
          ]});
        return i.reply({ embeds:[e] });
      }
    }

    // ── AUTOROLE ──────────────────────────────────────────────────────
    if (cmd === "autorole") {
      const sub = i.options.getSubcommand();
      const ar  = DB.autoRoles.get(guild.id) || new Set();
      if (sub === "add") {
        const role = i.options.getRole("role");
        ar.add(role.id); DB.autoRoles.set(guild.id, ar);
        return i.reply({ embeds:[Eok("Auto-Role Added",`New members will receive **${role.name}**.`)] });
      }
      if (sub === "remove") {
        const role = i.options.getRole("role");
        ar.delete(role.id); DB.autoRoles.set(guild.id, ar);
        return i.reply({ embeds:[Eok("Auto-Role Removed",`Removed **${role.name}** from auto-roles.`)] });
      }
      if (sub === "list") {
        if (!ar.size) return i.reply({ embeds:[Einf("Auto-Roles","No auto-roles set.")], ephemeral:true });
        return i.reply({ embeds:[Einf("Auto-Roles",[...ar].map(id=>`• <@&${id}>`).join("\n"))] });
      }
    }

    // ── RR (Reaction Roles) ───────────────────────────────────────────
    if (cmd === "rr") {
      const sub = i.options.getSubcommand();

      if (sub === "create") {
        await defer(true);
        const ch    = i.options.getChannel("channel");
        const name  = i.options.getString("name");
        const title = i.options.getString("title")       || "🎭  Choose Your Roles";
        const desc  = i.options.getString("description") || "React with an emoji below to receive your role!";
        const panelE = new EmbedBuilder().setTitle(title).setDescription(desc)
          .setColor(COL.primary).setTimestamp()
          .setFooter({ text:"React to get/remove a role" })
          .setThumbnail(guild.iconURL()??"");
        const panelMsg = await ch.send({ embeds:[panelE] });
        const panels = DB.rrPanels.get(guild.id) || new Map();
        panels.set(name, { channelId:ch.id, msgId:panelMsg.id, roles:new Map() });
        DB.rrPanels.set(guild.id, panels);
        return i.editReply({ embeds:[Eok("Panel Created",`Panel **${name}** posted in ${ch}.\nNow use \`/rr add ${name} <emoji> <role>\` to add roles.`)] });
      }

      if (sub === "add") {
        await defer(true);
        const panelName = i.options.getString("panel");
        const emoji     = i.options.getString("emoji").trim();
        const roleName  = i.options.getString("role").trim();
        const panels    = DB.rrPanels.get(guild.id);
        if (!panels?.has(panelName))
          return i.editReply({ embeds:[Eerr(`Panel **${panelName}** not found. Create one with \`/rr create\`.`)] });

        // find or create role
        let roleObj = guild.roles.cache.find(r=>r.name===roleName)
          ?? guild.roles.cache.get(roleName.replace(/[<@&>]/g,""));
        let created = false;
        if (!roleObj) {
          roleObj = await guild.roles.create({ name:roleName, reason:`Auto-created for RR panel ${panelName}` });
          created = true;
        }

        const panel = panels.get(panelName);
        panel.roles.set(emoji, roleObj.id);

        // update panel message
        const ch = guild.channels.cache.get(panel.channelId);
        if (ch) {
          try {
            const pmsg   = await ch.messages.fetch(panel.msgId);
            const rolesDesc = [...panel.roles.entries()].map(([em,rid])=>`${em}  →  <@&${rid}>`).join("\n");
            const updatedE  = EmbedBuilder.from(pmsg.embeds[0]).setDescription(rolesDesc);
            await pmsg.edit({ embeds:[updatedE] });
            await pmsg.react(emoji).catch(()=>{});
          } catch(ex) { console.error("[RR update]",ex.message); }
        }

        DB.rrPanels.set(guild.id, panels);
        const msg2 = `Added ${emoji} → **${roleObj.name}** to panel **${panelName}**.`
          + (created ? `\n*(Role **${roleObj.name}** was automatically created!)*` : "");
        return i.editReply({ embeds:[Eok("Reaction Role Added",msg2)] });
      }

      if (sub === "remove") {
        const panelName = i.options.getString("panel");
        const emoji     = i.options.getString("emoji").trim();
        const panels    = DB.rrPanels.get(guild.id);
        const panel     = panels?.get(panelName);
        if (!panel) return i.reply({ embeds:[Eerr("Panel not found.")], ephemeral:true });
        panel.roles.delete(emoji);
        return i.reply({ embeds:[Eok("Removed",`Removed ${emoji} from panel **${panelName}**.`)] });
      }

      if (sub === "list") {
        const panels = DB.rrPanels.get(guild.id);
        if (!panels?.size) return i.reply({ embeds:[Einf("Reaction Roles","No panels created yet.")], ephemeral:true });
        const e = E({title:"🎭  Reaction Role Panels",desc:"",color:COL.primary});
        for (const [name,p] of panels) {
          const roles = [...p.roles.entries()].map(([em,rid])=>`${em} → <@&${rid}>`).join("\n") || "No roles yet";
          e.addFields({ name:`📋  ${name}`, value:roles, inline:false });
        }
        return i.reply({ embeds:[e], ephemeral:true });
      }
    }

    // ── SETWELCOME ────────────────────────────────────────────────────
    if (cmd === "setwelcome") {
      const ch  = i.options.getChannel("channel");
      const msg2 = i.options.getString("message") || "Welcome to **{server}**, {user}! You are member #{count}. 🎉";
      DB.welcome.set(guild.id, { channelId:ch.id, msg:msg2 });
      return i.reply({ embeds:[Eok("Welcome Set",`Welcome messages → ${ch}\nMessage: \`${msg2}\``)] });
    }

    // ── SETLEAVE ──────────────────────────────────────────────────────
    if (cmd === "setleave") {
      const ch   = i.options.getChannel("channel");
      const msg2 = i.options.getString("message") || "Goodbye **{user}**, we'll miss you! 👋";
      DB.leave.set(guild.id, { channelId:ch.id, msg:msg2 });
      return i.reply({ embeds:[Eok("Leave Set",`Leave messages → ${ch}`)] });
    }

    // ── COUNTING ──────────────────────────────────────────────────────
    if (cmd === "counting") {
      const sub = i.options.getSubcommand();
      if (sub === "setup") {
        const ch = i.options.getChannel("channel");
        DB.counting.set(guild.id, { channelId:ch.id, count:0, lastUser:null, highScore:0 });
        return i.reply({ embeds:[Eok("Counting Setup",`Counting channel → ${ch}. Start counting from **1**!`)] });
      }
      if (sub === "reset") {
        const cnt = DB.counting.get(guild.id);
        if (!cnt) return i.reply({ embeds:[Eerr("Counting not set up.")], ephemeral:true });
        cnt.count=0; cnt.lastUser=null;
        return i.reply({ embeds:[Eok("Reset","Count reset to **0**.")] });
      }
      if (sub === "score") {
        const cnt = DB.counting.get(guild.id);
        if (!cnt) return i.reply({ embeds:[Eerr("Counting not set up.")], ephemeral:true });
        return i.reply({ embeds:[Einf("🔢  Counting Stats",`**Current Count:** ${cnt.count}\n**High Score:** ${cnt.highScore||0}`)] });
      }
    }

    // ── RANK ──────────────────────────────────────────────────────────
    if (cmd === "rank") {
      await defer();
      const target = i.options.getMember("user") ?? member;
      const u2     = target.user ?? target;
      const d2     = getXp(guild.id, u2.id);
      const needed = xpNeeded(d2.level);
      const rank   = getRank(guild.id, u2.id);
      const avURL  = u2.displayAvatarURL({ extension:"png", size:256 });
      if (ig) {
        try {
          const buf = await ig.makeRankCard({
            username:target.displayName??u2.username, discriminator:u2.discriminator,
            level:d2.level, xp:d2.xp, xpNeeded:needed, rank, avatarURL:avURL,
          });
          const att = new AttachmentBuilder(buf, { name:"rank.png" });
          const e   = new EmbedBuilder().setColor(COL.gold).setImage("attachment://rank.png")
            .setFooter({ text:`Requested by ${user.displayName}` }).setTimestamp();
          return i.editReply({ embeds:[e], files:[att] });
        } catch(ex) { console.error("[/rank]",ex.message); }
      }
      // text fallback
      const e = E({title:`📊  ${target.displayName}'s Rank`,desc:"",color:COL.gold,user:u2,
        fields:[
          {name:"Level",value:`**${d2.level}**`,inline:true},
          {name:"XP",   value:`**${d2.xp.toLocaleString()} / ${needed.toLocaleString()}**`,inline:true},
          {name:"Rank", value:`**#${rank}**`,inline:true},
        ]});
      return i.editReply({ embeds:[e] });
    }

    // ── LEADERBOARD ───────────────────────────────────────────────────
    if (cmd === "leaderboard") {
      await defer();
      const raw = [...DB.xp.entries()]
        .filter(([k])=>k.startsWith(`${guild.id}-`))
        .sort((a,b)=>b[1].level-a[1].level||b[1].xp-a[1].xp)
        .slice(0,10);
      if (!raw.length) return i.editReply({ embeds:[Eerr("No XP data yet! Chat to earn XP.")] });
      const entries = await Promise.all(raw.map(async([k,d],idx)=>{
        const uid = k.split("-")[1];
        let name="Unknown", disc="0000", avURL="";
        try {
          const m = guild.members.cache.get(uid) || await guild.members.fetch(uid);
          name=m.displayName; disc=m.user.discriminator;
          avURL=m.user.displayAvatarURL({ extension:"png", size:128 });
        } catch {}
        return { rank:idx+1, name, discriminator:disc, level:d.level, xp:d.xp,
                 xpNeeded:xpNeeded(d.level), avatarURL:avURL };
      }));
      if (ig) {
        try {
          const buf = await ig.makeLeaderboard({
            guildName:guild.name, guildIconURL:guild.iconURL()??"", entries,
          });
          const att = new AttachmentBuilder(buf, { name:"leaderboard.png" });
          const e   = new EmbedBuilder().setColor(COL.gold)
            .setTitle(`🏆  ${guild.name} Leaderboard`)
            .setImage("attachment://leaderboard.png")
            .setFooter({ text:`Top ${entries.length} members` }).setTimestamp();
          return i.editReply({ embeds:[e], files:[att] });
        } catch(ex) { console.error("[/leaderboard]",ex.message); }
      }
      // text fallback
      const medals = ["🥇","🥈","🥉"];
      const desc = entries.map((e,n)=>`${medals[n]??"**"+e.rank+".**"} <@${raw[n][0].split("-")[1]}> — Level **${e.level}** (${e.xp.toLocaleString()} XP)`).join("\n");
      return i.editReply({ embeds:[E({title:`🏆  Leaderboard`,desc,color:COL.gold})] });
    }

    // ── SETLEVEL ──────────────────────────────────────────────────────
    if (cmd === "setlevel") {
      const target = i.options.getMember("user");
      const level  = i.options.getInteger("level");
      forceLevel(guild.id, target.id, level);
      return i.reply({ embeds:[Eok("Level Set",`${target}'s level has been set to **${level}**.`,target.user)] });
    }

    // ── GIVEXP ────────────────────────────────────────────────────────
    if (cmd === "givexp") {
      const target = i.options.getMember("user");
      const amt    = i.options.getInteger("amount");
      const { d, leveled } = addXp(guild.id, target.id, amt);
      let msg2 = `Gave **${amt.toLocaleString()} XP** to ${target}.`;
      if (leveled) msg2 += ` They leveled up to **Level ${d.level}**! 🎉`;
      return i.reply({ embeds:[Eok("XP Granted",msg2,target.user)] });
    }

    // ── RESETXP ───────────────────────────────────────────────────────
    if (cmd === "resetxp") {
      const target = i.options.getMember("user");
      DB.xp.delete(xpKey(guild.id, target.id));
      return i.reply({ embeds:[Eok("XP Reset",`${target}'s XP has been reset.`,target.user)] });
    }

    // ── SETLOGCHANNEL ─────────────────────────────────────────────────
    if (cmd === "setlogchannel") {
      const ch = i.options.getChannel("channel");
      DB.logCh.set(guild.id, ch.id);
      return i.reply({ embeds:[Eok("Log Channel Set",`Mod logs → ${ch}`)] });
    }

    // ── USERINFO ──────────────────────────────────────────────────────
    if (cmd === "userinfo") {
      const target = i.options.getMember("user") ?? member;
      const u2     = target.user ?? target;
      const d2     = getXp(guild.id, u2.id);
      const roles  = target.roles?.cache.filter(r=>r.id!==guild.id).map(r=>r.toString()).join(" ") || "None";
      const e = E({ title:`👤  ${u2.tag}`, desc:"", color:COL.primary, user:u2,
        fields:[
          {name:"ID",         value:u2.id,                                                     inline:true},
          {name:"Joined",     value:`<t:${Math.floor(target.joinedTimestamp/1000)}:R>`,         inline:true},
          {name:"Created",    value:`<t:${Math.floor(u2.createdTimestamp/1000)}:R>`,            inline:true},
          {name:"Level",      value:`${d2.level}`,                                              inline:true},
          {name:"XP",         value:`${d2.xp.toLocaleString()}`,                               inline:true},
          {name:"Rank",       value:`#${getRank(guild.id,u2.id)}`,                             inline:true},
          {name:`Roles (${target.roles?.cache.size-1||0})`, value:roles.slice(0,1000)||"None", inline:false},
        ]});
      return i.reply({ embeds:[e] });
    }

    // ── SERVERINFO ────────────────────────────────────────────────────
    if (cmd === "serverinfo") {
      const g = guild;
      const e = E({ title:`🏠  ${g.name}`, desc:"", color:COL.primary,
        thumbnail:g.iconURL({dynamic:true})??"",
        fields:[
          {name:"Owner",       value:`<@${g.ownerId}>`,     inline:true},
          {name:"Members",     value:`${g.memberCount}`,    inline:true},
          {name:"Channels",    value:`${g.channels.cache.size}`, inline:true},
          {name:"Roles",       value:`${g.roles.cache.size}`,    inline:true},
          {name:"Boost Tier",  value:`Level ${g.premiumTier}`,   inline:true},
          {name:"Boosts",      value:`${g.premiumSubscriptionCount}`, inline:true},
          {name:"Created",     value:`<t:${Math.floor(g.createdTimestamp/1000)}:R>`, inline:true},
          {name:"Verification",value:`${g.verificationLevel}`, inline:true},
        ]});
      return i.reply({ embeds:[e] });
    }

    // ── AVATAR ────────────────────────────────────────────────────────
    if (cmd === "avatar") {
      const target = i.options.getUser("user") ?? user;
      const e = E({ title:`🖼️  ${target.username}'s Avatar`, desc:"", color:COL.primary });
      e.setImage(target.displayAvatarURL({ dynamic:true, size:1024 }));
      e.setThumbnail(null);
      return i.reply({ embeds:[e] });
    }

    // ── WHOIS ─────────────────────────────────────────────────────────
    if (cmd === "whois") {
      await defer();
      try {
        const u2 = await client.users.fetch(i.options.getString("id"));
        const e  = E({ title:`🔍  ${u2.tag}`, desc:"", color:COL.info, user:u2,
          fields:[
            {name:"ID",      value:u2.id,                                          inline:true},
            {name:"Created", value:`<t:${Math.floor(u2.createdTimestamp/1000)}:R>`,inline:true},
            {name:"Bot",     value:u2.bot?"Yes":"No",                              inline:true},
          ]});
        return i.editReply({ embeds:[e] });
      } catch {
        return i.editReply({ embeds:[Eerr("User not found.")] });
      }
    }

    // ══ FUN COMMANDS ═════════════════════════════════════════════════

    if (cmd === "8ball") {
      const q = i.options.getString("question");
      const a = EIGHTBALL[Math.floor(Math.random()*EIGHTBALL.length)];
      return i.reply({ embeds:[E({title:"🎱  Magic 8-Ball",desc:"",color:COL.purple,user,
        fields:[{name:"Question",value:q,inline:false},{name:"Answer",value:`**${a}**`,inline:false}]})] });
    }

    if (cmd === "coinflip") {
      const r = Math.random()<0.5 ? "🪙  **Heads!**" : "🪙  **Tails!**";
      return i.reply({ embeds:[E({title:"Coin Flip",desc:r,color:COL.gold,user})] });
    }

    if (cmd === "roll") {
      const sides = i.options.getInteger("sides") || 6;
      const r     = Math.floor(Math.random()*sides)+1;
      return i.reply({ embeds:[E({title:"🎲  Dice Roll",desc:`You rolled a **${r}** on a d${sides}!`,color:COL.teal,user})] });
    }

    if (cmd === "joke") {
      return i.reply({ embeds:[E({title:"😂  Joke",desc:JOKES[Math.floor(Math.random()*JOKES.length)],color:COL.teal})] });
    }

    if (cmd === "roast") {
      const target = i.options.getUser("user");
      const roast  = ROASTS[Math.floor(Math.random()*ROASTS.length)];
      return i.reply({ embeds:[E({title:"🔥  Roasted!",desc:`${target} — ${roast}`,color:COL.error,
        thumbnail:target.displayAvatarURL({dynamic:true}),
        footer:`Requested by ${user.displayName}`})] });
    }

    if (cmd === "compliment") {
      const target = i.options.getUser("user");
      const comp   = COMPLIMENTS[Math.floor(Math.random()*COMPLIMENTS.length)];
      return i.reply({ embeds:[E({title:"💖  Compliment!",desc:`${target} — ${comp}`,color:COL.pink,
        thumbnail:target.displayAvatarURL({dynamic:true}),
        footer:`From ${user.displayName}`})] });
    }

    if (cmd === "rps") {
      const choice = i.options.getString("choice");
      const bot2   = ["rock","paper","scissors"][Math.floor(Math.random()*3)];
      const emap   = { rock:"🪨", paper:"📄", scissors:"✂️" };
      const wins   = { rock:"scissors", paper:"rock", scissors:"paper" };
      const result = choice===bot2 ? "It's a **Tie!** 🤝"
        : wins[choice]===bot2 ? "You **Win!** 🎉" : "Bot **Wins!** 🤖";
      const col = choice===bot2?COL.warn : wins[choice]===bot2?COL.success:COL.error;
      return i.reply({ embeds:[E({title:"✂️  Rock Paper Scissors",desc:result,color:col,user,
        fields:[{name:"You",value:emap[choice],inline:true},{name:"Bot",value:emap[bot2],inline:true}]})] });
    }

    if (cmd === "meme") {
      return i.reply({ embeds:[E({title:"😂  Meme",desc:`*${MEMES[Math.floor(Math.random()*MEMES.length)]}*`,color:COL.purple})] });
    }

    if (cmd === "ship") {
      const u1  = i.options.getUser("user1");
      const u2  = i.options.getUser("user2") ?? user;
      const pct = Math.floor(Math.random()*101);
      const bar = "█".repeat(Math.floor(pct/10)) + "░".repeat(10-Math.floor(pct/10));
      const msg2 = `**${u1.username}** 💕 **${u2.username}**\n\n\`${bar}\` **${pct}%**\n\n${
        pct>80?"💍 True love! Get married already!"
        :pct>60?"💖 Strong connection!"
        :pct>40?"💛 Could work with effort!"
        :pct>20?"🤔 Meh... maybe?"
        :"💔 Not a match, sorry!"}`;
      return i.reply({ embeds:[E({title:"💕  Ship Calculator",desc:msg2,color:COL.pink})] });
    }

    if (cmd === "pp") {
      const target = i.options.getUser("user") ?? user;
      const size   = Math.floor(Math.random()*16);
      const pp     = `8${"=".repeat(size)}D`;
      return i.reply({ embeds:[E({title:"📏  PP Checker",
        desc:`${target.username}'s pp:\n\`${pp}\` (${size} inches)`,color:COL.teal})] });
    }

  } catch(err2) {
    console.error(`[/${cmd} error]`, err2);
    const errE = Eerr(`Something went wrong: ${err2.message}`);
    if (i.replied || i.deferred) i.followUp({ embeds:[errE], ephemeral:true }).catch(()=>{});
    else i.reply({ embeds:[errE], ephemeral:true }).catch(()=>{});
  }
});

// ═════════════════════════════════════════════════════════════════════════════
//  LAUNCH
// ═════════════════════════════════════════════════════════════════════════════
if (!TOKEN) {
  console.error("❌  No TOKEN in .env file! Add TOKEN=your_token to .env");
  process.exit(1);
}
client.login(TOKEN);
