export default {
	"*.{ts,tsx,js,jsx}": ["biome check --write --no-errors-on-unmatched"],
	"*.{json,css}": ["biome format --write --no-errors-on-unmatched"],
};
