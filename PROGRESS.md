# PROGRESS — Ad Astra (web)

## Estado
- Turno 1 (fundação): estrutura do projeto, núcleo determinístico (rng, time, engine, helpers, data loader), contratos em ARCHITECTURE.md.
- Demais módulos: em construção.

## Decisões
- Plataforma: navegador (mobile-first, retrato), GitHub Pages, sem build step, JS puro em ES modules; testes com `node --test`.
- Godot do GDD substituído por web; a separação dados → regras → interface do GDD foi mantida.
- Corte vertical: cenário Corrida Lunar 2026–2030, 1 turno = 1 semana.
