# Trademarks and vendor icons

archidraw is an independent open-source project. It is **not affiliated with, endorsed by, or
sponsored by** Amazon Web Services, Microsoft, Google, the Cloud Native Computing Foundation,
HashiCorp, or any other vendor whose products can be drawn with it.

AWS, Amazon Web Services and related marks are trademarks of Amazon.com, Inc. or its affiliates.
Microsoft and Azure are trademarks of the Microsoft group of companies. Google Cloud is a trademark
of Google LLC. Kubernetes is a registered trademark of The Linux Foundation. Terraform is a
trademark of HashiCorp, Inc. Other names are trademarks of their respective owners. They are used
here only to identify those products.

## Why vendor icons are not bundled

Vendor architecture icons are copyrighted artwork. Vendors generally permit their use **in
architecture diagrams**, but their terms don't clearly grant redistribution inside third-party
software. Microsoft, for example, permits use "in architectural diagrams, training materials, or
documentation" and forbids cropping, flipping, rotating or distorting the icons.

So archidraw:

1. Ships only icons whose licenses allow redistribution: Lucide (ISC) and Mermaid's built-in
   architecture icons.
2. Lets each user import an official pack they downloaded from the vendor, under the vendor's
   terms. The pack is stored locally in that user's app and is never uploaded or redistributed by
   archidraw.
3. Never alters imported icons beyond removing active content (scripts, event handlers, external
   links) for security.

Official download pages:

- AWS Architecture Icons: https://aws.amazon.com/architecture/icons/
- Azure architecture icons: https://learn.microsoft.com/azure/architecture/icons/
- Google Cloud icons: https://cloud.google.com/icons

## Rules for contributors

- Don't commit vendor icon files, logos, or derived artwork to this repository.
- Don't use vendor marks in archidraw's name, logo, app icon, or store listings. Factual phrases
  such as "imports Terraform" or "works with AWS diagrams" are fine.
- Don't imply that a vendor endorses archidraw.

This is not legal advice. If you're unsure about a specific use, consult a lawyer.
