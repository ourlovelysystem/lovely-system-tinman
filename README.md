# Tinman

Tinman is the voice-first listening surface for Our Lovely System and a mechanism that visibly records its own maintenance.

The landing page opens with up to twenty durable rust points. Visitors publicly self-identify, choose the oil can, and remove one point per squirt from Tinman or the interface. At zero, Tinman claims the axe and the restored background animation begins while the controls remain available.

The AWS SAM backend stores state and the public maintenance log in DynamoDB and adds a random zero through three rust points daily. See `backend/README.md` for deployment.

## Routes

- `/` — opening ritual and message browser landing surface
- `/appeals/` — appeal-mode recording control (next increment)
- `/accolades/` — reserved future behavior; no separate application or codebase

The route selects message behavior and tagging. It does not imply separate deployments.
