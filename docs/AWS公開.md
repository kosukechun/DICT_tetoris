# AWSへの公開

**製作者：ちゅん丸**

AWS CLIを使う従来の手順は廃止しました。現在は、ブラウザーで2つのYAMLファイルと専用ZIPをアップロードする構成です。

初心者向けの説明、用語、入力値、図、公開後の確認、更新、削除、トラブル対応は **[READMEのAWS公開手順](../README.md#awsに公開する手順ブラウザーだけで操作)** にまとめています。

アップロードするファイル：

1. CloudFormationに `infra/cloudformation.yaml`。
2. Elastic Beanstalkに `release/dict-tetoris.zip`。
3. CloudFormationに `infra/cloudfront.yaml`。

実際のAWSへのデプロイはまだ行っていません。
