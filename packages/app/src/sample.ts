export const SAMPLE = `---
title: Web application
---
architecture-beta
  group cloud(cloud)[Cloud]
  group private(lucide:network)[Private network] in cloud

  service users(lucide:users)[Users]
  service cdn(lucide:waypoints)[CDN]
  service lb(lucide:split)[Load balancer] in cloud
  service api(server)[API] in private
  service worker(lucide:square-function)[Worker] in private
  service queue(lucide:list-ordered)[Jobs queue] in private
  service db(database)[Database] in private

  users:R --> L:cdn
  cdn:R --> L:lb
  lb:R --> L:api
  api:R -[enqueue]-> L:queue
  queue:B --> T:worker
  api:B --> T:db

`;
