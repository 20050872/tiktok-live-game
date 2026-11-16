import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { TikTokConnectorAdapter } from './TikTokConnectorAdapter';
import { GameEventType, type StandardGameEvent } from '../types/events';
import type { GameEffect, GameEngineUpdate, GameGuild, GamePlayer, GameState, GuildId, PlayerClass } from '../types/game';

export type { GameEffect, GameEngineUpdate, GamePlayer, GameState } from '../types/game';

export interface GameEngineOptions {
  maxBossHealth?: number;
  chatDamage?: number;
  giftDamagePerRepeat?: number;
  followDamage?: number;
  likesPerDamage?: number;
  maxMana?: number;
  manaBlastDamage?: number;
  bossAttackIntervalMs?: number;
  bossTargetWindowMs?: number;
  bossAttackDamage?: number;
}

const CLASS_DETAILS: Record<PlayerClass, { label: string; avatar: string }> = {
  warrior: { label: 'Savaşçı', avatar: '🛡️' },
  archer: { label: 'Okçu', avatar: '🏹' },
  mage: { label: 'Büyücü', avatar: '🔮' },
};

function nonNegativeNumber(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result < 0) {
    throw new RangeError(`${name} sıfır veya pozitif bir sayı olmalı.`);
  }
  return result;
}

/** Standart event'lerden oyuncu durumunu ve boss canını yöneten oyun motoru. */
export class GameEngine extends EventEmitter {
  readonly maxBossHealth: number;
  private bossHealth: number;
  private readonly chatDamage: number;
  private readonly giftDamagePerRepeat: number;
  private readonly followDamage: number;
  private readonly likesPerDamage: number;
  readonly maxMana: number;
  private readonly manaBlastDamage: number;
  private readonly bossAttackIntervalMs: number;
  private readonly bossTargetWindowMs: number;
  private readonly bossAttackDamage: number;
  private readonly playersById = new Map<string, GamePlayer>();
  private mana = 0;
  private manaBlasts = 0;
  private bossTargetUserId: string | null = null;
  private bossAttackEndsAt: string | null = null;
  private mvpUserId: string | null = null;
  private currentEffects: GameEffect[] = [];
  private bossAttackInterval?: NodeJS.Timeout;
  private bossAttackTimeout?: NodeJS.Timeout;

  constructor(options: GameEngineOptions = {}) {
    super();
    this.maxBossHealth = nonNegativeNumber(options.maxBossHealth, 1000, 'maxBossHealth');
    if (this.maxBossHealth === 0) throw new RangeError('maxBossHealth sıfırdan büyük olmalı.');
    this.bossHealth = this.maxBossHealth;
    this.chatDamage = nonNegativeNumber(options.chatDamage, 1, 'chatDamage');
    this.giftDamagePerRepeat = nonNegativeNumber(options.giftDamagePerRepeat, 10, 'giftDamagePerRepeat');
    this.followDamage = nonNegativeNumber(options.followDamage, 5, 'followDamage');
    this.likesPerDamage = nonNegativeNumber(options.likesPerDamage, 10, 'likesPerDamage');
    if (this.likesPerDamage === 0) throw new RangeError('likesPerDamage sıfırdan büyük olmalı.');
    this.maxMana = nonNegativeNumber(options.maxMana, 100, 'maxMana');
    if (this.maxMana === 0) throw new RangeError('maxMana sıfırdan büyük olmalı.');
    this.manaBlastDamage = nonNegativeNumber(options.manaBlastDamage, 75, 'manaBlastDamage');
    this.bossAttackIntervalMs = nonNegativeNumber(options.bossAttackIntervalMs, 20_000, 'bossAttackIntervalMs');
    this.bossTargetWindowMs = nonNegativeNumber(options.bossTargetWindowMs, 7_000, 'bossTargetWindowMs');
    this.bossAttackDamage = nonNegativeNumber(options.bossAttackDamage, 25, 'bossAttackDamage');
  }

  getBossHealth(): number {
    return this.bossHealth;
  }

  getPlayers(): GamePlayer[] {
    return Array.from(this.playersById.values(), (player) => ({ ...player }));
  }

  getState(): GameState {
    const players = this.getPlayers();
    const guilds: GameGuild[] = ([
      { id: 'kraliyet', name: 'Kraliyet Loncası', score: 0, members: 0 },
      { id: 'golge', name: 'Gölge Loncası', score: 0, members: 0 },
    ] satisfies GameGuild[]).map((guild) => {
      const members = players.filter((player) => player.guildId === guild.id);
      return { ...guild, members: members.length, score: members.reduce((sum, player) => sum + player.damageDealt + player.supportPoints, 0) };
    });
    return { players, bossHealth: this.bossHealth, maxBossHealth: this.maxBossHealth, bossDefeated: this.bossHealth === 0, mana: this.mana, maxMana: this.maxMana, manaBlasts: this.manaBlasts, bossTargetUserId: this.bossTargetUserId, bossAttackEndsAt: this.bossAttackEndsAt, mvpUserId: this.mvpUserId, guilds, effects: [...this.currentEffects], updatedAt: new Date().toISOString() };
  }

  /** Canlı oturum açıldığında boss hedef seçme döngüsünü başlatır. */
  startBossAttacks(): void {
    if (this.bossAttackInterval || this.bossAttackIntervalMs === 0) return;
    this.bossAttackInterval = setInterval(() => this.targetRandomPlayer(), this.bossAttackIntervalMs);
    this.bossAttackInterval.unref?.();
  }

  /** Oturum kapanırken tüm oyun zamanlayıcılarını temizler. */
  stopBossAttacks(): void {
    if (this.bossAttackInterval) clearInterval(this.bossAttackInterval);
    if (this.bossAttackTimeout) clearTimeout(this.bossAttackTimeout);
    this.bossAttackInterval = undefined;
    this.bossAttackTimeout = undefined;
    const target = this.playersById.get(this.bossTargetUserId ?? '');
    if (target) target.isTargeted = false;
    this.bossTargetUserId = null;
    this.bossAttackEndsAt = null;
  }

  /** Adapter event emitter'ını motora bağlar ve bağlantıyı kaldıran bir fonksiyon döndürür. */
  attachAdapter(adapter: TikTokConnectorAdapter): () => void {
    const listener = (event: StandardGameEvent): void => {
      this.processEvent(event);
    };
    adapter.on(TikTokConnectorAdapter.EVENT_NAME, listener);
    return () => adapter.off(TikTokConnectorAdapter.EVENT_NAME, listener);
  }

  processEvent(event: StandardGameEvent): GameEngineUpdate {
    this.currentEffects = [];
    const eventDate = new Date(event.occurredAt);
    const occurredAt = Number.isNaN(eventDate.getTime()) ? new Date().toISOString() : eventDate.toISOString();
    let player = this.playersById.get(event.userId);

    if (!player) {
      player = {
        userId: event.userId,
        username: event.username,
        classId: 'adventurer',
        className: 'Gezgin',
        avatar: '🧝',
        guildId: null,
        health: 100,
        maxHealth: 100,
        isTargeted: false,
        totalMessages: 0,
        totalGiftRepeats: 0,
        totalLikes: 0,
        followCount: 0,
        joinCount: 0,
        damageDealt: 0,
        supportPoints: 0,
        giftValue: 0,
        minionsSummoned: 0,
        escapes: 0,
        buffExpiresAt: null,
        joinedAt: occurredAt,
        lastActiveAt: occurredAt,
      };
      this.playersById.set(event.userId, player);
    }

    player.username = event.username;
    if (event.displayName) player.displayName = event.displayName;
    player.lastActiveAt = occurredAt;
    if (player.health === 0) {
      player.health = player.maxHealth;
      this.addEffect('escape', `${player.displayName ?? player.username} yeniden arenaya döndü!`, player.userId);
    }

    let damage = 0;
    switch (event.type) {
      case GameEventType.CHAT:
        damage = this.handleChat(player, event.payload.message);
        break;
      case GameEventType.GIFT:
        player.totalGiftRepeats += event.payload.repeatCount;
        damage = this.handleGift(player, event.payload.giftName, event.payload.repeatCount, event.payload.diamondCount);
        break;
      case GameEventType.LIKE: {
        player.totalLikes += event.payload.count;
        player.supportPoints += event.payload.count;
        this.mana += event.payload.count;
        const blastCount = Math.floor(this.mana / this.maxMana);
        if (blastCount > 0) {
          this.mana %= this.maxMana;
          this.manaBlasts += blastCount;
          damage = Math.min(this.maxBossHealth, this.manaBlastDamage * Math.min(blastCount, 100));
          this.addDamage(player, damage);
          this.addEffect('mana-blast', `${player.displayName ?? player.username} ortak mana saldırısını tetikledi!`, player.userId, damage);
        }
        break;
      }
      case GameEventType.FOLLOW:
        player.followCount += 1;
        player.supportPoints += 5;
        damage = this.applyPlayerDamage(player, this.followDamage);
        this.addEffect('follow', `${player.displayName ?? player.username} arenaya katıldı.`, player.userId, damage);
        break;
      case GameEventType.JOIN:
        player.joinCount += 1;
        break;
    }

    if (this.bossHealth === 0 && !this.currentEffects.some((effect) => effect.type === 'boss-defeated')) {
      this.addEffect('boss-defeated', 'Boss yenildi! Kraliyet Arenası zafer kazandı.');
    }
    return this.publishState(event, player, damage);
  }

  private handleChat(player: GamePlayer, message: string): number {
    const parts = message.trim().toLocaleLowerCase('tr-TR').split(/\s+/);
    const command = parts[0];
    const classCommands: Record<string, PlayerClass> = {
      '!savasci': 'warrior',
      '!savaşçı': 'warrior',
      '!okcu': 'archer',
      '!okçu': 'archer',
      '!buyucu': 'mage',
      '!büyücü': 'mage',
    };
    const requestedClass = classCommands[command];
    if (requestedClass) {
      const details = CLASS_DETAILS[requestedClass];
      player.classId = requestedClass;
      player.className = details.label;
      player.avatar = details.avatar;
      player.totalMessages += 1;
      this.addEffect('class-assigned', `${player.displayName ?? player.username}, ${details.label} sınıfını seçti.`, player.userId);
      return 0;
    }

    if (command === '!lonca') {
      const guildAliases: Record<string, GuildId> = {
        kraliyet: 'kraliyet',
        kral: 'kraliyet',
        golge: 'golge',
        'gölge': 'golge',
      };
      const guildId = guildAliases[parts[1] ?? ''];
      if (guildId) {
        player.guildId = guildId;
        player.totalMessages += 1;
        this.addEffect('guild-joined', `${player.displayName ?? player.username}, ${guildId === 'kraliyet' ? 'Kraliyet' : 'Gölge'} Loncasına katıldı!`, player.userId);
        return 0;
      }
    }

    if (command === '!kac' || command === '!kaç') {
      player.totalMessages += 1;
      if (this.bossTargetUserId === player.userId) {
        if (this.bossAttackTimeout) clearTimeout(this.bossAttackTimeout);
        this.bossAttackTimeout = undefined;
        this.bossTargetUserId = null;
        this.bossAttackEndsAt = null;
        player.isTargeted = false;
        player.escapes += 1;
        player.supportPoints += 20;
        this.addEffect('escape', `${player.displayName ?? player.username} boss saldırısından sıyrıldı!`, player.userId);
      } else {
        this.addEffect('escape', `${player.displayName ?? player.username} kaçış komutu kullandı.`, player.userId);
      }
      return 0;
    }

    player.totalMessages += 1;
    const classMultiplier = player.classId === 'warrior' ? 1.4 : player.classId === 'archer' ? 1.2 : player.classId === 'mage' ? 1.1 : 1;
    const buffActive = player.buffExpiresAt !== null && Date.parse(player.buffExpiresAt) > Date.now();
    const damage = Math.ceil(this.chatDamage * classMultiplier * (buffActive ? 2 : 1));
    const actualDamage = this.applyPlayerDamage(player, damage);
    this.addEffect('chat-attack', `${player.avatar} ${player.displayName ?? player.username} saldırdı!`, player.userId, actualDamage);
    return actualDamage;
  }

  private handleGift(player: GamePlayer, giftName: string, repeatCount: number, diamondCount?: number): number {
    const value = Math.max(1, (diamondCount ?? 1) * repeatCount);
    player.giftValue += value;
    player.supportPoints += value;
    const previousMvp = this.mvpUserId;
    const mvp = this.getPlayers().sort((a, b) => b.giftValue - a.giftValue)[0];
    if (mvp && mvp.giftValue > 0) this.mvpUserId = mvp.userId;
    const mvpChanged = previousMvp !== this.mvpUserId && this.mvpUserId === player.userId;

    if (value < 5) {
      player.buffExpiresAt = new Date(Date.now() + 15_000).toISOString();
      this.addEffect('speed-buff', `${player.avatar} ${player.displayName ?? player.username} hızlandı! ${giftName} buff verdi.`, player.userId, value, giftName);
      if (mvpChanged) this.addEffect('mvp', `👑 ${player.displayName ?? player.username} hediye MVP oldu!`, player.userId, value, giftName);
      return 0;
    }
    if (value < 100) {
      const minions = Math.min(5, repeatCount);
      player.minionsSummoned += minions;
      const damage = this.applyPlayerDamage(player, this.giftDamagePerRepeat * minions);
      this.addEffect('minion-summoned', `${minions} yardımcı minion ${giftName} hediyesi için savaşa katıldı!`, player.userId, damage, giftName);
      if (mvpChanged) this.addEffect('mvp', `👑 ${player.displayName ?? player.username} hediye MVP oldu!`, player.userId, value, giftName);
      return damage;
    }

    const meteorDamage = Math.min(500, 100 + Math.ceil(value * 0.5));
    const damage = this.applyPlayerDamage(player, meteorDamage);
    this.addEffect('meteor', `☄️ ${giftName} meteor yağmuru!`, player.userId, damage, giftName);
    if (mvpChanged) this.addEffect('mvp', `👑 ${player.displayName ?? player.username} hediye MVP oldu!`, player.userId, value, giftName);
    return damage;
  }

  private addDamage(player: GamePlayer, damage: number): void {
    player.damageDealt += damage;
    this.bossHealth = Math.max(0, this.bossHealth - damage);
  }

  private applyPlayerDamage(player: GamePlayer, damage: number): number {
    const actualDamage = Math.min(this.bossHealth, damage);
    this.addDamage(player, actualDamage);
    return actualDamage;
  }

  private addEffect(type: GameEffect['type'], message: string, userId?: string, value?: number, giftName?: string): GameEffect {
    const effect: GameEffect = { id: randomUUID(), type, message, createdAt: new Date().toISOString(), ...(userId ? { userId } : {}), ...(value === undefined ? {} : { value }), ...(giftName ? { giftName } : {}) };
    this.currentEffects.push(effect);
    return effect;
  }

  private targetRandomPlayer(): void {
    if (this.bossHealth <= 0 || this.bossTargetUserId) return;
    const candidates = Array.from(this.playersById.values()).filter((player) => player.health > 0);
    if (!candidates.length) return;
    const target = candidates[Math.floor(Math.random() * candidates.length)];
    this.currentEffects = [];
    this.bossTargetUserId = target.userId;
    this.bossAttackEndsAt = new Date(Date.now() + this.bossTargetWindowMs).toISOString();
    target.isTargeted = true;
    this.addEffect('boss-target', `⚠️ Boss ${target.displayName ?? target.username} oyuncusunu hedef aldı! Sohbete !kac yaz!`, target.userId);
    this.publishState(this.systemEvent(), target, 0);
    this.bossAttackTimeout = setTimeout(() => this.resolveBossAttack(target.userId), this.bossTargetWindowMs);
    this.bossAttackTimeout.unref?.();
  }

  private resolveBossAttack(userId: string): void {
    if (this.bossTargetUserId !== userId) return;
    const target = this.playersById.get(userId);
    this.currentEffects = [];
    if (target) {
      target.isTargeted = false;
      target.health = Math.max(0, target.health - this.bossAttackDamage);
      this.addEffect('boss-hit', `Boss saldırısı ${target.displayName ?? target.username} oyuncusuna isabet etti!`, target.userId, this.bossAttackDamage);
    }
    this.bossTargetUserId = null;
    this.bossAttackEndsAt = null;
    this.bossAttackTimeout = undefined;
    if (target) this.publishState(this.systemEvent(), target, 0);
  }

  private systemEvent(): StandardGameEvent {
    return {
      eventId: randomUUID(),
      type: GameEventType.JOIN,
      userId: 'game-system',
      username: 'Kraliyet Arenası',
      occurredAt: new Date().toISOString(),
      payload: {},
    };
  }

  private publishState(event: StandardGameEvent, player: GamePlayer, damage: number): GameEngineUpdate {
    const players = this.getPlayers();
    const guilds: GameGuild[] = ([
      { id: 'kraliyet', name: 'Kraliyet Loncası', score: 0, members: 0 },
      { id: 'golge', name: 'Gölge Loncası', score: 0, members: 0 },
    ] satisfies GameGuild[]).map((guild) => {
      const members = players.filter((candidate) => candidate.guildId === guild.id);
      return {
        ...guild,
        members: members.length,
        score: members.reduce((score, candidate) => score + candidate.damageDealt + candidate.supportPoints, 0),
      };
    });
    const gameState: GameState = {
      players,
      bossHealth: this.bossHealth,
      maxBossHealth: this.maxBossHealth,
      bossDefeated: this.bossHealth === 0,
      mana: this.mana,
      maxMana: this.maxMana,
      manaBlasts: this.manaBlasts,
      bossTargetUserId: this.bossTargetUserId,
      bossAttackEndsAt: this.bossAttackEndsAt,
      mvpUserId: this.mvpUserId,
      guilds,
      effects: [...this.currentEffects],
      updatedAt: new Date().toISOString(),
    };
    const update: GameEngineUpdate = { event, player: { ...player }, damage, gameState };
    this.emit('state:updated', update);
    return update;
  }
}
