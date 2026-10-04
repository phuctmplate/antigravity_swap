import React from 'react';

export const LogoIcon: React.FC<React.SVGProps<SVGSVGElement>> = ({ className, ...props }) => (
  <svg
    viewBox="0 0 512 512"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={className}
    {...props}
  >
    <path
      d="M319.531 60.5C514.031 126 513 406.5 283.531 463C196.5 419.5 163 314.5 219.531 221C207 297.5 207.5 359 289.031 412.5C458 350 468.531 139 319.531 60.5Z"
      fill="url(#ag_swap_logo_paint0)"
    />
    <path
      d="M192.292 450.5C-2.20798 385 -1.17719 104.5 228.292 48C315.323 91.5 348.823 196.5 292.292 290C304.823 213.5 304.323 152 222.792 98.5C53.8228 161 43.2921 372 192.292 450.5Z"
      fill="url(#ag_swap_logo_paint1)"
    />
    <defs>
      <linearGradient
        id="ag_swap_logo_paint0"
        x1="325.064"
        y1="461.99"
        x2="325.064"
        y2="60.5"
        gradientUnits="userSpaceOnUse"
      >
        <stop stopColor="#D41609" />
        <stop offset="0.5" stopColor="#FD3F20" />
        <stop offset="1" stopColor="#FF6F43" />
      </linearGradient>
      <linearGradient
        id="ag_swap_logo_paint1"
        x1="186.759"
        y1="49.01"
        x2="186.759"
        y2="450.5"
        gradientUnits="userSpaceOnUse"
      >
        <stop stopColor="#D41609" />
        <stop offset="0.5" stopColor="#FD3F20" />
        <stop offset="1" stopColor="#FF6F43" />
      </linearGradient>
    </defs>
  </svg>
);
