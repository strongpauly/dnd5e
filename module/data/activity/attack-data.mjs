import simplifyRollFormula from "../../dice/simplify-roll-formula.mjs";
import FormulaField from "../fields/formula-field.mjs";
import DamageField from "../shared/damage-field.mjs";
import BaseActivityData from "./base-activity.mjs";

const { ArrayField, BooleanField, NumberField, SchemaField, StringField } = foundry.data.fields;

/**
 * Data model for an attack activity.
 *
 * @property {object} attack
 * @property {string} attack.ability              Ability used to make the attack and determine damage.
 * @property {string} attack.bonus                Arbitrary bonus added to the attack.
 * @property {object} attack.critical
 * @property {number} attack.critical.threshold   Minimum value on the D20 needed to roll a critical hit.
 * @property {boolean} attack.flat                Should the bonus be used in place of proficiency & ability modifier?
 * @property {object} attack.type
 * @property {string} attack.type.value           Is this a melee or ranged attack?
 * @property {string} attack.type.classification  Is this a unarmed, weapon, or spell attack?
 * @property {object} damage
 * @property {object} damage.critical
 * @property {string} damage.critical.bonus       Extra damage applied when a critical is rolled. Added to the base
 *                                                damage or first damage part.
 * @property {boolean} damage.includeBase         Should damage defined by the item be included with other damage parts?
 * @property {DamageData[]} damage.parts          Parts of damage to inflict.
 */
export default class AttackActivityData extends BaseActivityData {
  /** @inheritDoc */
  static defineSchema() {
    return {
      ...super.defineSchema(),
      attack: new SchemaField({
        ability: new StringField(),
        bonus: new FormulaField(),
        critical: new SchemaField({
          threshold: new NumberField({ integer: true, positive: true })
        }),
        flat: new BooleanField(),
        type: new SchemaField({
          value: new StringField(),
          classification: new StringField()
        })
      }),
      damage: new SchemaField({
        critical: new SchemaField({
          bonus: new FormulaField()
        }),
        includeBase: new BooleanField({ initial: true }),
        parts: new ArrayField(new DamageField())
      })
    };
  }

  /* -------------------------------------------- */
  /*  Properties                                  */
  /* -------------------------------------------- */

  /** @override */
  get ability() {
    if ( this.attack.ability === "none" ) return null;
    if ( this.attack.ability === "spellcasting" ) return this.spellcastingAbility;
    if ( this.attack.ability in CONFIG.DND5E.abilities ) return this.attack.ability;

    const availableAbilities = this.availableAbilities;
    if ( !availableAbilities?.size ) return null;
    if ( availableAbilities?.size === 1 ) return availableAbilities.first();
    const abilities = this.actor?.system.abilities ?? {};
    return availableAbilities.reduce((largest, ability) =>
      (abilities[ability]?.mod ?? -Infinity) > (abilities[largest]?.mod ?? -Infinity) ? ability : largest
    , availableAbilities.first());
  }

  /* -------------------------------------------- */

  /** @override */
  get actionType() {
    const type = this.attack.type;
    return `${type.value === "ranged" ? "r" : "m"}${type.classification === "spell" ? "sak" : "wak"}`;
  }

  /* -------------------------------------------- */

  /**
   * Abilities that could potentially be used with this attack. Unless a specific ability is specified then
   * whichever ability has the highest modifier will be selected when making an attack.
   * @type {Set<string>}
   */
  get availableAbilities() {
    // Defer to item if available
    if ( this.item.system.availableAbilities ) return this.item.system.availableAbilities;

    // Spell attack not associated with a single class, use highest spellcasting ability on actor
    if ( this.attack.type.classification === "spell" ) return new Set(
      this.actor?.system.attributes?.spellcasting
        ? [this.actor.system.attributes.spellcasting]
        : Object.values(this.actor?.spellcastingClasses ?? {}).map(c => c.spellcasting.ability)
    );

    // Weapon & unarmed attacks uses melee or ranged ability depending on type, or both if actor is an NPC
    const melee = CONFIG.DND5E.defaultAbilities.meleeAttack;
    const ranged = CONFIG.DND5E.defaultAbilities.rangedAttack;
    if ( this.actor?.type === "npc" ) return new Set([melee, ranged]);
    return new Set([this.attack.type.value === "melee" ? melee : ranged]);
  }

  /* -------------------------------------------- */

  /**
   * Critical threshold for attacks with this activity.
   * @type {number}
   */
  get criticalThreshold() {
    let ammoThreshold;
    // TODO: Fetch threshold from ammo
    const threshold = Math.min(
      this.attack.critical.threshold ?? Infinity,
      this.item.system.criticalThreshold ?? Infinity,
      ammoThreshold ?? Infinity
    );
    return threshold < Infinity ? threshold : 20;
  }

  /* -------------------------------------------- */
  /*  Data Migrations                             */
  /* -------------------------------------------- */

  /** @override */
  static transformTypeData(source, activityData, options) {
    // For weapons and ammunition, separate the first part from the rest to be used as the base damage and keep the rest
    let damageParts = source.system.damage?.parts ?? [];
    const hasBase = (source.type === "weapon")
      || ((source.type === "consumable") && (source.system?.type?.value === "ammo"));
    if ( hasBase && damageParts.length ) {
      const [base, ...rest] = damageParts;
      source.system.damage.parts = [base];
      damageParts = rest;
    }

    return foundry.utils.mergeObject(activityData, {
      attack: {
        ability: source.system.ability ?? "",
        bonus: source.system.attack?.bonus ?? "",
        critical: {
          threshold: source.system.critical?.threshold
        },
        flat: source.system.attack?.flat ?? false,
        type: {
          value: source.system.actionType.startsWith("m") ? "melee" : "ranged",
          classification: source.system.actionType.endsWith("wak") ? "weapon" : "spell"
        }
      },
      damage: {
        critical: {
          bonus: source.system.critical?.damage
        },
        includeBase: true,
        parts: damageParts.map(part => this.transformDamagePartData(source, part)) ?? []
      }
    });
  }

  /* -------------------------------------------- */
  /*  Data Preparation                            */
  /* -------------------------------------------- */

  /** @inheritDoc */
  prepareData() {
    super.prepareData();
    this.attack.type.value ||= this.item.system.attackType ?? "";
    this.attack.type.classification ||= this.item.system.attackClassification ?? "";
  }

  /* -------------------------------------------- */

  /** @inheritDoc */
  prepareFinalData(rollData) {
    if ( this.damage.includeBase && this.item.system.offersBaseDamage && this.item.system.damage.base.formula ) {
      const basePart = this.item.system.damage.base.clone(this.item.system.damage.base.toObject(false));
      basePart.base = true;
      basePart.locked = true;
      this.damage.parts.unshift(basePart);
    }

    rollData ??= this.getRollData({ deterministic: true });
    super.prepareFinalData(rollData);
    this.prepareDamageLabel(this.damage.parts, rollData);

    const { data, parts } = this.getAttackData();
    const roll = new Roll(parts.join("+"), data);
    this.labels.modifier = simplifyRollFormula(roll.formula, { deterministic: true }) || "0";
    const formula = simplifyRollFormula(roll.formula) || "0";
    this.labels.toHit = !/^[+-]/.test(formula) ? `+${formula}` : formula;
  }

  /* -------------------------------------------- */
  /*  Helpers                                     */
  /* -------------------------------------------- */

  /**
   * The game term label for this attack.
   * @param {string} [attackMode]  The mode the attack was made with.
   * @returns {string}
   */
  getActionLabel(attackMode) {
    let attackModeLabel;
    if ( attackMode ) {
      const key = attackMode.split("-").map(s => s.capitalize()).join("");
      attackModeLabel = game.i18n.localize(`DND5E.ATTACK.Mode.${key}`);
    }
    let actionType = this.actionType;
    if ( (actionType === "mwak") && (attackMode?.startsWith("thrown")) ) actionType = "rwak";
    let actionTypeLabel = game.i18n.localize(`DND5E.Action${actionType.toUpperCase()}`);
    const isLegacy = game.settings.get("dnd5e", "rulesVersion") === "legacy";
    const isUnarmed = this.attack.type.classification === "unarmed";
    if ( isUnarmed ) attackModeLabel = game.i18n.localize("DND5E.ATTACK.Classification.Unarmed");
    const isSpell = (actionType === "rsak") || (actionType === "msak");
    if ( isLegacy || isSpell ) return [actionTypeLabel, attackModeLabel].filterJoin(" &bull; ");
    actionTypeLabel = game.i18n.localize(`DND5E.ATTACK.Attack.${actionType}`);
    if ( isUnarmed ) return [actionTypeLabel, attackModeLabel].filterJoin(" &bull; ");
    const weaponType = CONFIG.DND5E.weaponTypeMap[this.item.system.type?.value];
    const weaponTypeLabel = weaponType
      ? game.i18n.localize(`DND5E.ATTACK.Weapon.${weaponType.capitalize()}`)
      : CONFIG.DND5E.weaponTypes[this.item.system.type?.value];
    return [actionTypeLabel, weaponTypeLabel, attackModeLabel].filterJoin(" &bull; ");
  }

  /* -------------------------------------------- */

  /**
   * Get the roll parts used to create the attack roll.
   * @param {object} [config={}]
   * @param {string} [config.ammunition]
   * @param {string} [config.attackMode]
   * @param {string} [config.situational]
   * @returns {{ data: object, parts: string[] }}
   */
  getAttackData({ ammunition, attackMode, situational }={}) {
    const rollData = this.getRollData();
    if ( this.attack.flat ) return CONFIG.Dice.BasicRoll.constructParts({ toHit: this.attack.bonus }, rollData);

    const weapon = this.item.system;
    const ammo = this.actor?.items.get(ammunition)?.system;
    const { parts, data } = CONFIG.Dice.BasicRoll.constructParts({
      mod: this.attack.ability !== "none" ? rollData.mod : null,
      prof: weapon.prof?.term,
      bonus: this.attack.bonus,
      weaponMagic: weapon.magicAvailable ? weapon.magicalBonus : null,
      ammoMagic: ammo?.magicAvailable ? ammo.magicalBonus : null,
      actorBonus: this.actor?.system.bonuses?.[this.actionType]?.attack,
      situational
    }, rollData);

    // Add exhaustion reduction
    this.actor?.addRollExhaustion(parts, data);

    return { data, parts };
  }

  /* -------------------------------------------- */

  /**
   * @typedef {AttackDamageRollProcessConfiguration} [config={}]
   * @property {Item5e} ammunition  Ammunition used with the attack.
   * @property {"oneHanded"|"twoHanded"|"offhand"|"thrown"|"thrown-offhand"} attackMode  Attack mode.
   */

  /**
   * Get the roll parts used to create the damage rolls.
   * @param {Partial<AttackDamageRollProcessConfiguration>} [config={}]
   * @returns {AttackDamageRollProcessConfiguration}
   */
  getDamageConfig(config={}) {
    const rollConfig = super.getDamageConfig(config);

    // Handle ammunition
    const ammo = config.ammunition?.system;
    if ( ammo ) {
      const properties = Array.from(ammo.properties).filter(p => CONFIG.DND5E.itemProperties[p]?.isPhysical);
      if ( this.item.system.properties?.has("mgc") && !properties.includes("mgc") ) properties.push("mgc");

      // Add any new physical properties from the ammunition to the damage properties
      for ( const roll of rollConfig.rolls ) {
        for ( const property of properties ) {
          if ( !roll.options.properties.includes(property) ) roll.options.properties.push(property);
        }
      }

      // Add the ammunition's damage
      if ( ammo.damage.base.formula ) {
        const basePartIndex = rollConfig.rolls.findIndex(i => i.base);
        const damage = ammo.damage.base.clone();
        const rollData = this.getRollData();

        // If mode is "replace" and base part is present, replace the base part
        if ( ammo.damage.replace & (basePartIndex !== -1) ) {
          damage.base = true;
          rollConfig.rolls.splice(basePartIndex, 1, this._processDamagePart(damage, config, rollData, basePartIndex));
        }

        // Otherwise stick the ammo damage after base part (or as first part)
        else {
          damage.ammo = true;
          rollConfig.rolls.splice(
            basePartIndex + 1, 0, this._processDamagePart(damage, rollConfig, rollData, basePartIndex + 1)
          );
        }
      }
    }

    if ( this.damage.critical.bonus && !rollConfig.rolls[0]?.options?.critical?.bonusDamage ) {
      foundry.utils.setProperty(rollConfig.rolls[0], "options.critical.bonusDamage", this.damage.critical.bonus);
    }

    return rollConfig;
  }

  /* -------------------------------------------- */

  /** @inheritDoc */
  _processDamagePart(damage, rollConfig, rollData, index=0) {
    if ( !damage.base ) return super._processDamagePart(damage, rollConfig, rollData, index);

    // Swap base damage for versatile if two-handed attack is made on versatile weapon
    if ( this.item.system.isVersatile && (rollConfig.attackMode === "twoHanded") ) {
      const versatile = this.item.system.damage.versatile.clone();
      versatile.base = true;
      versatile.denomination ||= damage.steppedDenomination();
      versatile.number ||= damage.number;
      versatile.types = damage.types;
      damage = versatile;
    }

    const roll = super._processDamagePart(damage, rollConfig, rollData, index);
    roll.base = true;

    if ( this.item.type === "weapon" ) {
      // Ensure `@mod` is present in damage unless it is positive and an off-hand attack or damage is a flat value
      const isDeterministic = new Roll(roll.parts[0]).isDeterministic;
      const includeMod = (!rollConfig.attackMode?.endsWith("offhand") || (roll.data.mod < 0)) && !isDeterministic;
      if ( includeMod && !roll.parts.some(p => p.includes("@mod")) ) roll.parts.push("@mod");

      // Add magical bonus
      if ( this.item.system.magicalBonus && this.item.system.magicAvailable ) {
        roll.parts.push("@magicalBonus");
        roll.data.magicalBonus = this.item.system.magicalBonus;
      }

      // Add ammunition bonus
      const ammo = rollConfig.ammunition?.system;
      if ( ammo?.magicAvailable && ammo.magicalBonus ) {
        roll.parts.push("@ammoBonus");
        roll.data.ammoBonus = ammo.magicalBonus;
      }
    }

    const criticalBonusDice = this.actor?.getFlag("dnd5e", "meleeCriticalDamageDice") ?? 0;
    if ( (this.actionType === "mwak") && (parseInt(criticalBonusDice) !== 0) ) {
      foundry.utils.setProperty(roll, "options.critical.bonusDice", criticalBonusDice);
    }

    return roll;
  }
}
