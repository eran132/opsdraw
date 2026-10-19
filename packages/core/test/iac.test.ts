import { describe, expect, it } from 'vitest';
import type { Diagram } from '../src';
import {
  detectIac,
  iconForResourceType,
  importIac,
  parseArchitecture,
  parseCloudFormation,
  parseCompose,
  parseKubernetes,
  serializeArchitecture,
} from '../src';

const byId = (d: Diagram) => Object.fromEntries(d.nodes.map((n) => [n.id, n]));
const pairs = (d: Diagram) => d.edges.map((e) => `${e.from}->${e.to}`).sort();
const expectValidMermaid = (d: Diagram) => {
  const text = serializeArchitecture(d);
  expect(parseArchitecture(text).errors).toEqual([]);
};

const CFN = `AWSTemplateFormatVersion: '2010-09-09'
Description: Queue worker
Parameters:
  Env:
    Type: String
Conditions:
  IsProd: !Equals [!Ref Env, prod]
Resources:
  Vpc:
    Type: AWS::EC2::VPC
    Properties:
      CidrBlock: 10.0.0.0/16
  PrivateSubnet:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref Vpc
      CidrBlock: !Select [0, !Cidr [!GetAtt Vpc.CidrBlock, 4, 8]]
      AvailabilityZone: !Select [0, !GetAZs '']
  DbSubnets:
    Type: AWS::RDS::DBSubnetGroup
    Properties:
      DBSubnetGroupDescription: db
      SubnetIds: [!Ref PrivateSubnet]
  Database:
    Type: AWS::RDS::DBInstance
    Properties:
      Engine: postgres
      DBSubnetGroupName: !Ref DbSubnets
      MultiAZ: !If [IsProd, true, false]
  Jobs:
    Type: AWS::SQS::Queue
  WorkerRole:
    Type: AWS::IAM::Role
    Properties:
      AssumeRolePolicyDocument: {}
  Worker:
    Type: AWS::Lambda::Function
    Properties:
      Role: !GetAtt WorkerRole.Arn
      VpcConfig:
        SubnetIds: [!Ref PrivateSubnet]
      Environment:
        Variables:
          DB_URL: !Sub 'postgres://\${Database.Endpoint.Address}:5432/\${AWS::StackName}'
          STAGE: !Join ['-', [!Ref Env, !ImportValue shared-stage]]
  JobsMapping:
    Type: AWS::Lambda::EventSourceMapping
    Properties:
      EventSourceArn: !GetAtt [Jobs, Arn]
      FunctionName: !Ref Worker
  Uploads:
    Type: AWS::S3::Bucket
  UploadsPolicy:
    Type: AWS::S3::BucketPolicy
    Properties:
      Bucket: !Ref Uploads
  Workflow:
    Type: AWS::StepFunctions::StateMachine
    Properties:
      DefinitionSubstitutions:
        Fn: !GetAtt Worker.Arn
`;

describe('cloudformation import', () => {
  it('parses short-form tags, nests in networks, hides plumbing, links via connectors', () => {
    const d = parseCloudFormation([{ path: 'stack.yaml', content: CFN }]);
    const n = byId(d);
    expect(Object.keys(n).sort()).toEqual(
      ['Database', 'Jobs', 'PrivateSubnet', 'Uploads', 'Vpc', 'Worker', 'Workflow'].sort(),
    );
    expect(n.Vpc).toMatchObject({ kind: 'group' });
    expect(n.PrivateSubnet).toMatchObject({ kind: 'group', parent: 'Vpc' });
    expect(n.Worker).toMatchObject({ parent: 'PrivateSubnet', icon: 'lucide:square-function' });
    // Nested through the hidden DB subnet group.
    expect(n.Database).toMatchObject({ parent: 'PrivateSubnet', icon: 'database' });
    expect(n.Jobs!.icon).toBe('lucide:list-ordered');
    expect(n.Uploads!.icon).toBe('lucide:archive');
    expect(n.Workflow!.icon).toBe('lucide:workflow');
    expect(pairs(d)).toEqual(['Worker->Database', 'Worker->Jobs', 'Workflow->Worker']);
    expectValidMermaid(d);
  });

  it('reads JSON templates and keeps plumbing with includeAll', () => {
    const json = JSON.stringify({
      Resources: {
        Topic: { Type: 'AWS::SNS::Topic' },
        Queue: { Type: 'AWS::SQS::Queue' },
        Sub: {
          Type: 'AWS::SNS::Subscription',
          Properties: { TopicArn: { Ref: 'Topic' }, Endpoint: { 'Fn::GetAtt': ['Queue', 'Arn'] } },
        },
      },
    });
    const d = parseCloudFormation([{ path: 'stack.json', content: json }]);
    expect(d.nodes.map((n) => n.id).sort()).toEqual(['Queue', 'Topic']);
    expect(pairs(d)).toEqual(['Queue->Topic']);
    const all = parseCloudFormation([{ path: 'stack.json', content: json }], { includeAll: true });
    expect(all.nodes).toHaveLength(3);
    expectValidMermaid(all);
  });

  it('maps CloudFormation types onto the shared icon rules', () => {
    expect(iconForResourceType('AWS::ElasticLoadBalancingV2::LoadBalancer')).toBe('lucide:split');
    expect(iconForResourceType('AWS::CloudFront::Distribution')).toBe('lucide:waypoints');
    expect(iconForResourceType('AWS::DynamoDB::Table')).toBe('database');
    expect(iconForResourceType('AWS::EC2::Instance')).toBe('server');
    expect(iconForResourceType('aws_lambda_function')).toBe('lucide:square-function');
  });
});

const K8S = `apiVersion: v1
kind: Namespace
metadata:
  name: shop
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: shop
spec:
  selector:
    matchLabels: { app: web }
  template:
    metadata:
      labels: { app: web, tier: frontend }
    spec:
      containers:
        - name: web
          image: ghcr.io/acme/web:1.2
          envFrom:
            - configMapRef: { name: web-config }
---
apiVersion: v1
kind: Service
metadata:
  name: web
  namespace: shop
spec:
  selector: { app: web }
  ports: [{ port: 80 }]
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: public
  namespace: shop
spec:
  rules:
    - host: shop.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service: { name: web, port: { number: 80 } }
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: web-config
  namespace: shop
data: { LOG_LEVEL: info }
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: web
  namespace: shop
spec:
  scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: web }
---
apiVersion: v1
kind: List
items:
  - apiVersion: apps/v1
    kind: StatefulSet
    metadata:
      name: postgres
      namespace: data
    spec:
      selector:
        matchLabels: { app: postgres }
      template:
        metadata:
          labels: { app: postgres }
        spec:
          containers:
            - name: postgres
              image: postgres:16
          volumes:
            - name: data
              persistentVolumeClaim: { claimName: pg-data }
  - apiVersion: v1
    kind: Service
    metadata:
      name: postgres
      namespace: data
    spec:
      selector: { app: postgres }
  - apiVersion: v1
    kind: PersistentVolumeClaim
    metadata:
      name: pg-data
      namespace: data
    spec:
      accessModes: [ReadWriteOnce]
`;

describe('kubernetes import', () => {
  it('groups by namespace, links services by selector and ingresses by backend', () => {
    const d = parseKubernetes([{ path: 'k8s.yaml', content: K8S }]);
    const n = byId(d);
    expect(Object.keys(n).sort()).toEqual(
      [
        'ns_shop',
        'ns_data',
        'deployment_web',
        'service_web',
        'public',
        'statefulset_postgres',
        'service_postgres',
        'pg-data',
      ].sort(),
    );
    expect(n.ns_shop).toMatchObject({ kind: 'group', label: 'shop' });
    expect(n.deployment_web).toMatchObject({
      parent: 'ns_shop',
      icon: 'lucide:container',
      label: 'web',
    });
    expect(n.service_web!.icon).toBe('lucide:split');
    expect(n.public!.icon).toBe('internet');
    expect(n.statefulset_postgres).toMatchObject({ parent: 'ns_data', icon: 'database' });
    expect(n['pg-data']!.icon).toBe('disk');
    expect(pairs(d)).toEqual([
      'public->service_web',
      'service_postgres->statefulset_postgres',
      'service_web->deployment_web',
      'statefulset_postgres->pg-data',
    ]);
    expectValidMermaid(d);
  });

  it('shows config, secrets and autoscalers with includeAll', () => {
    const d = parseKubernetes([{ path: 'k8s.yaml', content: K8S }], { includeAll: true });
    const n = byId(d);
    expect(n['web-config']!.icon).toBe('lucide:file-cog');
    expect(n.horizontalpodautoscaler_web!.icon).toBe('lucide:activity');
    expect(pairs(d)).toEqual(
      expect.arrayContaining([
        'deployment_web->web-config',
        'horizontalpodautoscaler_web->deployment_web',
      ]),
    );
    expectValidMermaid(d);
  });

  it('skips namespace groups when everything is in one namespace', () => {
    const d = parseKubernetes([
      {
        path: 'a.yaml',
        content:
          'apiVersion: v1\nkind: Pod\nmetadata: { name: job1 }\nspec: { containers: [{ image: redis:7 }] }\n',
      },
    ]);
    expect(d.nodes).toEqual([{ id: 'job1', kind: 'service', label: 'job1', icon: 'lucide:zap' }]);
  });
});

const COMPOSE = `name: shop
services:
  proxy:
    image: nginx:1.27
    depends_on: [api]
    networks: [frontend]
  api:
    build: ./api
    depends_on:
      db:
        condition: service_healthy
      cache:
        condition: service_started
    links:
      - "queue:mq"
    networks:
      backend: {}
      frontend: {}
    volumes:
      - ./api:/app
      - uploads:/data/uploads
  db:
    image: postgres:16-alpine
    networks: [backend]
    volumes:
      - type: volume
        source: pgdata
        target: /var/lib/postgresql/data
  cache:
    image: redis:7
    networks: [backend]
  queue:
    image: rabbitmq:3-management
networks:
  frontend:
  backend:
volumes:
  pgdata:
  uploads:
`;

describe('compose import', () => {
  it('maps services, depends_on (list and map), links and named networks', () => {
    const d = parseCompose([{ path: 'docker-compose.yml', content: COMPOSE }]);
    const n = byId(d);
    expect(Object.keys(n).sort()).toEqual([
      'api',
      'backend',
      'cache',
      'db',
      'frontend',
      'proxy',
      'queue',
    ]);
    expect(n.frontend).toMatchObject({ kind: 'group', label: 'frontend' });
    expect(n.proxy).toMatchObject({ parent: 'frontend', icon: 'lucide:split' });
    // First listed network wins.
    expect(n.api).toMatchObject({ parent: 'backend', icon: 'lucide:container' });
    expect(n.db).toMatchObject({ parent: 'backend', icon: 'database' });
    expect(n.cache!.icon).toBe('lucide:zap');
    expect(n.queue!.icon).toBe('lucide:radio-tower');
    expect(n.queue!.parent).toBeUndefined();
    expect(pairs(d)).toEqual(['api->cache', 'api->db', 'api->queue', 'proxy->api']);
    expectValidMermaid(d);
  });

  it('adds named volumes with includeAll and skips groups for the default network', () => {
    const d = parseCompose([{ path: 'compose.yaml', content: COMPOSE }], { includeAll: true });
    expect(byId(d).pgdata!.icon).toBe('disk');
    expect(pairs(d)).toEqual(expect.arrayContaining(['api->uploads', 'db->pgdata']));
    expectValidMermaid(d);

    const flat = parseCompose([
      { path: 'compose.yaml', content: 'services:\n  a: { image: x }\n  b: { depends_on: [a] }\n' },
    ]);
    expect(flat.nodes.every((x) => x.kind === 'service' && !x.parent)).toBe(true);
    expect(pairs(flat)).toEqual(['b->a']);
  });
});

describe('iac detection and import', () => {
  it('detects formats by name and content', () => {
    expect(detectIac('infra/main.tf', '')).toBe('terraform');
    expect(detectIac('stack.yaml', CFN)).toBe('cloudformation');
    expect(detectIac('t.json', '{"Resources":{"A":{"Type":"AWS::SQS::Queue"}}}')).toBe(
      'cloudformation',
    );
    expect(detectIac('deploy/app.yaml', K8S)).toBe('kubernetes');
    expect(detectIac('docker-compose.prod.yml', '')).toBe('compose');
    expect(detectIac('stack.yml', COMPOSE)).toBe('compose');
    expect(detectIac('README.md', '# hi')).toBeNull();
    expect(detectIac('values.yaml', 'replicas: 2\n')).toBeNull();
  });

  it('merges several kinds with prefixed ids and reports skipped files', () => {
    const r = importIac([
      {
        path: 'main.tf',
        content: 'resource "aws_sqs_queue" "jobs" {}\nresource "aws_sns_topic" "events" {}',
      },
      { path: 'compose.yaml', content: COMPOSE },
      { path: 'k8s.yaml', content: K8S },
      { path: 'notes.txt', content: 'hello' },
    ]);
    expect(r.kinds).toEqual(['terraform', 'kubernetes', 'compose']);
    expect(r.skipped).toEqual(['notes.txt']);
    const n = byId(r.diagram);
    expect(n.tf_jobs).toBeDefined();
    expect(n.compose_api).toMatchObject({ parent: 'compose_backend' });
    expect(n.k8s_deployment_web).toMatchObject({ parent: 'k8s_ns_shop' });
    expect(pairs(r.diagram)).toContain('compose_proxy->compose_api');
    expectValidMermaid(r.diagram);
  });

  it('returns a single kind unprefixed', () => {
    const r = importIac([{ path: 'docker-compose.yml', content: COMPOSE }]);
    expect(r.kinds).toEqual(['compose']);
    expect(byId(r.diagram).api).toBeDefined();
  });
});
