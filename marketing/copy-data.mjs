function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

export const MARKETING_COPY_VERSION = 1;

export const MARKETING_COPY = deepFreeze({
  shared: {
    internalTest: '首批内测',
    freeCustom: '免费定制',
    desktopPet: '专属桌面宠物',
    offerFull: '免费定制专属桌面宠物',
    valueFull: '把熟悉的它，带到你的电脑桌面。',
    featureList: '摸摸 · 投喂 · 玩具 · 亲密度',
    participationFull: '你提供宠物照片，并在体验后告诉我真实感受。',
    voluntaryShareFull: '愿意的话，也欢迎随缘分享。',
    status: '内测功能以实际安装版本为准。',
    realScreen: '实际程序画面',
  },
  portraitTwo: {
    headlineLead: '这次内测，需要你的',
    headlineTail: '照片与反馈',
    step1Number: '1',
    step1Title: '提供照片',
    step1DetailLead: '正面、侧面、花色与神态',
    step1DetailTail: '越清楚越好。',
    step2Number: '2',
    step2Title: '体验宠物',
    step2DetailLead: '在桌面摸摸、投喂、',
    step2DetailTail: '玩玩具。',
    step3Number: '3',
    step3Title: '告诉我感受',
    step3DetailLead: '动作、还原度与问题，',
    step3DetailTail: '都欢迎真实反馈。',
  },
  githubHero: {
    productName: 'PET DESKTOP COMPANION',
    badge: '首批内测 · 免费定制',
    titleLead: '把真实宠物，',
    titleMiddle: '做成会陪你的',
    titleTail: '桌面伙伴',
    detailLead: '你提供照片与真实反馈；愿意的话，',
    detailTail: '也欢迎随缘分享。',
  },
  video: {
    valueLead: '把熟悉的它，',
    valueTail: '带到你的电脑桌面',
    proofHeadline: '它真的会出现在桌面上',
    proofDisclaimer: '真实截图，不绘制或拼接应用界面',
    interactionBadge: '互动与养成',
    interactionLead: '不只是看看，',
    interactionTail: '也能一起玩',
    petTitle: '摸摸',
    petDetail: '点击不同部位互动',
    feedTitle: '投喂',
    feedDetail: '零食陪伴日常',
    toyTitle: '玩具',
    toyDetail: '毛线球与逗猫棒',
    intimacyTitle: '亲密度',
    intimacyDetail: '互动逐步解锁',
    participationBadge: '参与方式',
    participationLead: '这次内测，',
    participationTail: '需要你的照片与反馈',
    photoTitle: '你提供宠物照片',
    photoDetail: '正面、侧面、花色与神态，越清楚越好。',
    feedbackTitle: '体验后告诉我感受',
    feedbackDetail: '动作、还原度与使用问题，都欢迎真实反馈。',
    voluntaryShareLead: '愿意的话，',
    voluntaryShareTail: '也欢迎随缘分享',
    closingParticipationLead: '你提供宠物照片，并在体验后',
    closingParticipationTail: '告诉我真实感受。',
  },
});

export function flattenMarketingCopy(value = MARKETING_COPY, prefix = '') {
  const entries = [];
  for (const [name, nested] of Object.entries(value)) {
    const key = prefix ? `${prefix}.${name}` : name;
    if (typeof nested === 'string') {
      entries.push(Object.freeze({ key, value: nested }));
    } else if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      entries.push(...flattenMarketingCopy(nested, key));
    } else {
      throw new TypeError(`Marketing copy entry ${key} must be a string or plain object.`);
    }
  }
  return entries;
}

export const MARKETING_COPY_ENTRIES = Object.freeze(flattenMarketingCopy());
