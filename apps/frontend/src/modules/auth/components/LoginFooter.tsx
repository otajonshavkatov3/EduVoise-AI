export function LoginFooter() {
	return (
		<div className="mt-8 text-center lg:text-left">
			{/* Avval bu yerda "Contact administrator" havolasi `/` ga ishora qilardi —
			    hech qanday sahifaga olib bormaydigan havola oddiy matnga aylantirildi. */}
			<p className="text-sm text-gray-500">
				Hisobingiz bo'lmasa — tizim administratoriga murojaat qiling.
			</p>
		</div>
	);
}
