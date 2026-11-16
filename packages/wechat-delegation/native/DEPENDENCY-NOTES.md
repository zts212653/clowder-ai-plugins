# Tokio定时器安全更新

2026-11-17，本次重写从原锁继承的`tokio=1.54.0`已改为精确`=1.54.1`并更新Cargo.lock，其他registry包版本不变。检查前没有把yanked解释为恶意或凭据泄漏。

| Claim | 原始来源及时间 | 适用与未知 | 审计结论 |
| --- | --- | --- | --- |
| 1.54.0已撤回，1.54.1未撤回 | 2026-11-17直接读取[crates.io版本API](https://crates.io/api/v1/crates/tokio/1.54.0)与[官方索引](https://index.crates.io/to/ki/tokio)，分别核yanked和checksum | registry当前状态；不是撤回原因的独立证据 | source=use；non-triviality=not-compared（版本事实无创新比较）；decision-fit=direct |
| 撤回原因是Interval多线程定时器竞态，可能破坏内存，官方修复为1.54.1 | 维护者[GHSA-5wjr-9356-4wc8](https://github.com/tokio-rs/tokio/security/advisories/GHSA-5wjr-9356-4wc8)，2026-10-21发布、10-23更新；[修复PR8692](https://github.com/tokio-rs/tokio/pull/8692)及[1.54.1 release](https://github.com/tokio-rs/tokio/releases/tag/tokio-1.54.1) | 公告限定Interval，Sleep/Timeout不在该公告影响内。自身协议/link源码未查到Interval直接调用；尚未证明所有transitive路径不可达，也未在本机重现UAF。不能推导账号遭攻击或整个1.54.1零漏洞 | source=use（维护者公告、源码改动和registry同链核验，不当作多方独立复现）；non-triviality=not-compared；decision-fit=direct用于移除已知受影响pin，运行触发适用性仅partial |

GitHub材料经canonical `gh api`回读；维护者同时是修复提供者，结论归于维护者声明，没有商业比较或独立漏洞复现。比较tag显示仅2个commit：修复`5ed619bbaba87357ee5103d71b75e7c84cad99c9`和发布`b53b2001ed2ccfd9b87e32a0c6da1a1eebdc80b8`。直接读过变更中的TimerEntry取消同步、析构恢复及上游竞态测试，未把release标题当全部证据。

最小处置是同一依赖的小版本安全补丁，不自写计时器或增加重试/替代runtime。1.54.1源码包SHA-256：`b52fd3255258d26fac7264ab5a76b53c13367136dc011d3d6ad4f8ed070396a3`，实际下载文件、锁和官方索引一致。没有升级其它包或增加新的外部依赖种类。

本轮`cargo test --locked`完整workspace通过（11持久层主测试、父测试实际启动的1个restart子测试、2IPC、1stdio进程、96协议、6compile-fail）；`cargo build --offline --locked`通过。原始日志在共享工作区`meow-talk/output/wechat-delegation-security-rewrite/dependencies/`。这是兼容回归与固定构建检查，**不是本机先红后绿重现上游竞态**；第一次offline/locked解析因旧缓存/锁拒绝新pin，随后定向cargo update只改变tokio版本和摘要。

当前运行插件仍未替换，未处理真实凭据或执行微信请求；正式制品、账号服务接线、官方pin来源及最终安全验收仍保持未完成。
