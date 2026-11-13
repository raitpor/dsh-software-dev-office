# `all` 不重建图：重建会把过期产物"改对"再让 design-check 比对，等于自己骗自己。
# 需要重建时显式跑 `make design`（生成的 .puml/.dot 也是产物，仍然只由模板生成）。
check:
	python3 docs/check.py

probe:
	python3 probe/run.py

design:
	python3 design/diagrams/build.py

design-check:
	python3 design/check.py

# 实现层：骨架起于 M0-0（卡 plan/cards/M0-0.md）。docs/probe/design 与它互不依赖。
test:
	npm test

all: check probe design-check

# 从零开始：重建图，再跑全套检查
fresh: design all

.PHONY: check probe design design-check test all fresh
