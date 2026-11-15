'use strict';

/**
 * Compatibilidade com o formato de perfil da exportação mínima da base ({ resolution, codec, bitrateKbps }),
 * usado só pelos canais legados export:warnings / export:run. A aba Exportar nova usa os perfis de profiles.js.
 */

const { validateProfile } = require('./profiles');

const RESOLUTIONS = Object.freeze({
  1080: { width: 1080, height: 1920 },
  1440: { width: 1440, height: 2560 },
  2160: { width: 2160, height: 3840 }
});

/** { resolution, codec, bitrateKbps } -> { profile (formato 3.1), errors } */
function legacyProfile(input = {}) {
  const src = { resolution: 1080, codec: 'h264', bitrateKbps: 10000, ...input };
  const res = RESOLUTIONS[src.resolution];
  const errors = [];
  if (!res) errors.push('Resolução inválida: use 1080, 1440 ou 2160.');
  const checked = validateProfile({
    id: `vertical-${src.resolution}-${src.codec}`, name: `9:16 ${src.resolution}p`, kind: 'vertical',
    width: res ? res.width : 1080, height: res ? res.height : 1920, codec: src.codec, bitrateKbps: src.bitrateKbps
  });
  errors.push(...checked.errors);
  return { profile: checked.profile, errors };
}

/** Avisos não impeditivos da combinação fonte x perfil (recorte central que preenche o quadro). */
function legacyWarnings(profile, source) {
  const warnings = [];
  if (!source || !(source.width > 0) || !(source.height > 0)) return warnings;
  const scale = Math.max(profile.width / source.width, profile.height / source.height);
  if (scale > 1) {
    warnings.push(`A fonte (${source.width}x${source.height}) tem resolução menor que a exportação (${profile.width}x${profile.height}); o vídeo será ampliado e não ganha detalhe.`);
  }
  if (profile.codec === 'h265') warnings.push('H.265 é menos compatível com alguns players e plataformas que H.264.');
  return warnings;
}

module.exports = { RESOLUTIONS, legacyProfile, legacyWarnings };
